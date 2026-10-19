// The composable is a binding over the SDK's store, whose own behaviour is tested
// with it. What is proven here is the binding: nothing is fetched on a server
// render, the session is fetched once mounted and lands in the refs, a new session
// id is a new store rather than the old one repointed, and a live watch is held
// only while the rail is answering and released with the component.
import { flush } from './dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createSSRApp, defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useCheckoutSession, type UseCheckoutSession } from '../src/useCheckoutSession.js';

interface Call {
  url: string;
  signal: AbortSignal | undefined;
}

/** A core stand-in: reads answer with the session for the id in the path; the stream stays open. */
function core(statusFor: (id: string) => string) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, signal: init?.signal ?? undefined });
    const id = /checkout_sessions\/([^/?]+)/.exec(target)?.[1] ?? '';
    if (target.includes('/stream')) {
      const body = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ id, version: 1, status: statusFor(id), next_action: null }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function harness(options: () => Parameters<typeof useCheckoutSession>[0]) {
  let bound!: UseCheckoutSession;
  const Probe = defineComponent({
    setup() {
      bound = useCheckoutSession(options());
      return () => h('p', bound.phase.value);
    },
  });
  return { Probe, get bound() { return bound; } };
}

test('a server render fetches nothing and renders the loading state', async () => {
  const stub = core(() => 'requires_payment_method');
  const { Probe } = harness(() => ({ sessionId: 'cs_1', clientSecret: 's', baseUrl: 'https://core.test', fetch: stub.fetch }));
  const html = await renderToString(createSSRApp(Probe));
  assert.equal(html, '<p>loading</p>');
  assert.equal(stub.calls.length, 0, 'a server render must not reach the core');
});

test('the session is fetched once mounted and lands in the refs', async () => {
  const stub = core(() => 'requires_payment_method');
  const h1 = harness(() => ({ sessionId: 'cs_1', clientSecret: 's', baseUrl: 'https://core.test', fetch: stub.fetch }));
  const app = createApp(h1.Probe);
  app.mount(document.createElement('div'));
  await flush();

  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0]!.url, /\/v1\/checkout_sessions\/cs_1$/);
  assert.equal(h1.bound.phase.value, 'ready');
  assert.equal(h1.bound.session.value?.id, 'cs_1');
  app.unmount();
});

test('a new session id is driven by a fresh store', async () => {
  const stub = core(() => 'requires_payment_method');
  const sessionId: Ref<string> = ref('cs_1');
  const h1 = harness(() => () => ({ sessionId: sessionId.value, clientSecret: 's', baseUrl: 'https://core.test', fetch: stub.fetch }));
  const app = createApp(h1.Probe);
  app.mount(document.createElement('div'));
  await flush();

  sessionId.value = 'cs_2';
  await nextTick();
  await flush();
  assert.match(stub.calls.at(-1)!.url, /\/cs_2$/);
  assert.equal(h1.bound.session.value?.id, 'cs_2', 'the refs follow the new session');

  // An action addresses the current session, never the one it left.
  await h1.bound.refresh();
  assert.match(stub.calls.at(-1)!.url, /\/cs_2$/);
  app.unmount();
});

test('a watch is held while the rail answers and released with the component', async () => {
  const stub = core(() => 'processing');
  const h1 = harness(() => ({ sessionId: 'cs_1', clientSecret: 's', baseUrl: 'https://core.test', fetch: stub.fetch }));
  const app = createApp(h1.Probe);
  app.mount(document.createElement('div'));
  await flush();

  const stream = stub.calls.find((c) => c.url.includes('/stream'));
  assert.ok(stream, 'a session waiting on the rail is watched');
  assert.equal(h1.bound.watching.value, true);

  app.unmount();
  assert.equal(stream.signal?.aborted, true, 'the stream closes with the component');
});

test('no watch while the buyer is still choosing', async () => {
  const stub = core(() => 'requires_payment_method');
  const h1 = harness(() => ({ sessionId: 'cs_1', clientSecret: 's', baseUrl: 'https://core.test', fetch: stub.fetch }));
  const app = createApp(h1.Probe);
  app.mount(document.createElement('div'));
  await flush();
  assert.equal(stub.calls.some((c) => c.url.includes('/stream')), false);
  assert.equal(h1.bound.watching.value, false);
  app.unmount();
});
