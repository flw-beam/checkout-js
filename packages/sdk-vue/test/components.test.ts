// The two components are wrappers over the runtime, so what is worth proving is
// the wrapping: that a frame is mounted for the session and destroyed with the
// component, that one never outlives a mount that was already over when the
// runtime arrived, that only the session's identity remounts it, and that the
// runtime's signals reach the parent as events. The runtime itself is stood in for
// on `window.FlutterwavebnwCheckout`, where the loader looks first — which is what a page
// with the script tag already on it looks like.
import { dom, flush } from './dom.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createSSRApp } from 'vue';
import type { MountOptions, MountCardFieldOptions, CardFieldAppearance } from '@flutterwavebnw/checkout-runtime';
import { CheckoutDropIn } from '../src/CheckoutDropIn.js';
import { CardField, type CardFieldExposed } from '../src/CardField.js';

interface FakeFrame {
  options: MountOptions;
  destroyed: boolean;
}
interface FakeField {
  options: MountCardFieldOptions;
  destroyed: boolean;
  appearance: CardFieldAppearance[];
  captures: number;
}

const frames: FakeFrame[] = [];
const fields: FakeField[] = [];
// Any origin will do: the runtime is already on the page, so nothing is fetched.
const ORIGIN = 'https://checkout.test';

(dom.window as unknown as Record<string, unknown>).FlutterwavebnwCheckout = {
  protocolVersion: 1,
  mount(options: MountOptions) {
    const frame: FakeFrame = { options, destroyed: false };
    frames.push(frame);
    return { frame: null, destroy: () => (frame.destroyed = true) };
  },
  mountCardField(options: MountCardFieldOptions) {
    const field: FakeField = { options, destroyed: false, appearance: [], captures: 0 };
    fields.push(field);
    return {
      frame: null,
      destroy: () => (field.destroyed = true),
      setAppearance: (a: CardFieldAppearance) => field.appearance.push(a),
      focus: () => {},
      clear: () => {},
      capture: async () => {
        field.captures += 1;
        return { token: 'tok_1', display: 'Visa 4242', last4: '4242', issuer: '424242', expiresAt: null };
      },
    };
  },
  presentStepUp: () => ({ blocked: false, close: () => {} }),
};

beforeEach(() => {
  frames.length = 0;
  fields.length = 0;
  document.body.innerHTML = '';
});

function mountApp(render: () => ReturnType<typeof h>): { app: App; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render });
  app.mount(root);
  return { app, root };
}

test('the drop-in mounts a frame for the session into its own element', async () => {
  const { app, root } = mountApp(() => h(CheckoutDropIn, { origin: ORIGIN, sessionId: 'cs_1', clientSecret: 'cs_1_secret', class: 'pay' }));
  await flush();

  assert.equal(frames.length, 1);
  const [frame] = frames;
  assert.equal(frame!.options.sessionId, 'cs_1');
  assert.equal(frame!.options.clientSecret, 'cs_1_secret');
  assert.equal(frame!.options.container, root.firstElementChild, 'mounted into the component root');
  assert.equal(root.firstElementChild?.className, 'pay', 'class falls through for layout');

  app.unmount();
  assert.equal(frame!.destroyed, true, 'the frame goes with the component');
});

test('a drop-in unmounted before the runtime arrives never mounts a frame', async () => {
  // The load resolves a tick later even with the runtime already on the page, so
  // an unmount in the same tick is the race a navigation or a v-if flip runs.
  const { app } = mountApp(() => h(CheckoutDropIn, { origin: ORIGIN, sessionId: 'cs_1', clientSecret: 'cs_1_secret' }));
  app.unmount();
  await flush();
  assert.equal(frames.length, 0);
});

test('only the session identity remounts the drop-in', async () => {
  const sessionId = ref('cs_1');
  const tone = ref('light');
  mountApp(() => h(CheckoutDropIn, { origin: ORIGIN, sessionId: sessionId.value, clientSecret: `${sessionId.value}_secret`, class: tone.value }));
  await flush();

  tone.value = 'dark';
  await nextTick();
  await flush();
  assert.equal(frames.length, 1, 'a class change must not tear down a payment in progress');

  sessionId.value = 'cs_2';
  await nextTick();
  await flush();
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.destroyed, true, 'the previous session frame is destroyed');
  assert.equal(frames[1]!.options.sessionId, 'cs_2');
});

test('the drop-in forwards the runtime signals as events', async () => {
  const seen: string[] = [];
  mountApp(() =>
    h(CheckoutDropIn, {
      origin: ORIGIN,
      sessionId: 'cs_1',
      clientSecret: 'cs_1_secret',
      onSession: (s: { status: string }) => seen.push(`session:${s.status}`),
      'onStep-up': (info: { blocked: boolean }) => seen.push(`step-up:${info.blocked}`),
      onTimeout: () => seen.push('timeout'),
    }),
  );
  await flush();

  const { options } = frames[0]!;
  options.onSession?.({ sessionId: 'cs_1', status: 'processing', livemode: false, buyerFinal: false });
  options.onStepUp?.({ blocked: true });
  options.onTimeout?.();
  assert.deepEqual(seen, ['session:processing', 'step-up:true', 'timeout']);
});

test('a fetched session is fetched by the runtime, under the key the parent named', async () => {
  const fetchSession = async () => ({ sessionId: 'cs_1', clientSecret: 'cs_1_secret' });
  mountApp(() => h(CheckoutDropIn, { origin: ORIGIN, fetchSession, reuseKey: 'order_42' }));
  await flush();

  assert.equal(frames.length, 1);
  const { options } = frames[0]!;
  assert.equal(options.reuseKey, 'order_42');
  assert.equal(options.sessionId, undefined, 'a fetched mount passes no session of its own');
  assert.deepEqual(await options.fetchSession!(), { sessionId: 'cs_1', clientSecret: 'cs_1_secret' });
});

test('a new fetchSession function is not a new purchase; a new key is', async () => {
  // An inline arrow in a template is a new function on every render. Remounting
  // on it would ask the merchant's server for a session per render.
  const label = ref('first');
  const reuseKey = ref('order_42');
  let latest = '';
  mountApp(() =>
    h(CheckoutDropIn, {
      origin: ORIGIN,
      reuseKey: reuseKey.value,
      class: label.value,
      fetchSession: async () => {
        latest = label.value;
        return { sessionId: 'cs_1', clientSecret: 'cs_1_secret' };
      },
    }),
  );
  await flush();

  label.value = 'second';
  await nextTick();
  await flush();
  assert.equal(frames.length, 1);
  await frames[0]!.options.fetchSession!();
  assert.equal(latest, 'second', 'the mounted frame calls the function passed last');

  reuseKey.value = 'order_43';
  await nextTick();
  await flush();
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.destroyed, true);
});

test('a closed checkout arrives as a closed event with its session', async () => {
  const told: string[] = [];
  mountApp(() =>
    h(CheckoutDropIn, {
      origin: ORIGIN,
      sessionId: 'cs_1',
      clientSecret: 'cs_1_secret',
      onClosed: (info: { sessionId: string }) => told.push(info.sessionId),
    }),
  );
  await flush();
  frames[0]!.options.onClosed?.({ sessionId: 'cs_1' });
  assert.deepEqual(told, ['cs_1']);
});

test('a failed fetch arrives as the same error event as a runtime that never loaded', async () => {
  const errors: string[] = [];
  mountApp(() =>
    h(CheckoutDropIn, {
      origin: ORIGIN,
      fetchSession: async () => ({ sessionId: 'cs_1', clientSecret: 'cs_1_secret' }),
      onError: (err: Error) => errors.push(err.message),
    }),
  );
  await flush();
  frames[0]!.options.onError?.(new Error('cart is empty'));
  assert.deepEqual(errors, ['cart is empty']);
});

test('a server render produces the empty container and mounts nothing', async () => {
  const html = await renderToString(
    createSSRApp({ render: () => h(CheckoutDropIn, { origin: ORIGIN, sessionId: 'cs_1', clientSecret: 'cs_1_secret' }) }),
  );
  assert.equal(html, '<div></div>');
  await flush();
  assert.equal(frames.length, 0);
});

test('the card field capture goes to the field on the page', async () => {
  const handle = ref<CardFieldExposed | null>(null);
  const { app } = mountApp(() => h(CardField, { origin: ORIGIN, ref: handle, sessionId: 'cs_1', clientSecret: 'cs_1_secret' }));

  await assert.rejects(handle.value!.capture(), (err: Error & { code?: string }) => err.code === 'field_unreachable');

  await flush();
  const card = await handle.value!.capture();
  assert.equal(card.token, 'tok_1');
  assert.equal(fields[0]!.captures, 1);

  const exposed = handle.value!;
  app.unmount();
  assert.equal(fields[0]!.destroyed, true);
  await assert.rejects(exposed.capture(), (err: Error & { code?: string }) => err.code === 'field_destroyed');
});

test('an appearance change restyles the live field instead of remounting it', async () => {
  const appearance = ref<CardFieldAppearance>({ color: '#111111' });
  mountApp(() => h(CardField, { origin: ORIGIN, sessionId: 'cs_1', clientSecret: 'cs_1_secret', appearance: appearance.value }));
  await flush();
  assert.deepEqual(fields[0]!.options.appearance, { color: '#111111' });

  appearance.value = { color: '#eeeeee' };
  await nextTick();
  await flush();
  assert.equal(fields.length, 1, 'restyling must not empty what the buyer typed');
  assert.deepEqual(fields[0]!.appearance, [{ color: '#eeeeee' }]);
});

test('the card field forwards the entry state as events', async () => {
  const seen: unknown[] = [];
  mountApp(() =>
    h(CardField, {
      origin: ORIGIN,
      sessionId: 'cs_1',
      clientSecret: 'cs_1_secret',
      onChange: (s: unknown) => seen.push(s),
      onReady: () => seen.push('ready'),
      onUnavailable: (i: { code: string }) => seen.push(i.code),
    }),
  );
  await flush();
  const { options } = fields[0]!;
  options.onReady?.();
  options.onChange?.({ empty: false, complete: true, error: null });
  options.onUnavailable?.({ code: 'vault_unavailable', message: 'no vault' });
  assert.deepEqual(seen, ['ready', { empty: false, complete: true, error: null }, 'vault_unavailable']);
});
