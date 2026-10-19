import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { CheckoutSessionStore } from '../src/store.js';
import { CheckoutError } from '../src/errors.js';
import type { CoreError } from '../src/types.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface StubResponse {
  status?: number;
  json?: unknown;
}

function stub(responder: (c: Captured) => StubResponse) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const r = responder(calls[calls.length - 1]!);
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : '', { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function newStore(fetchImpl: typeof fetch) {
  return new CheckoutSessionStore({
    sessionId: 'cs_1',
    clientSecret: 'cs_secret',
    baseUrl: 'https://checkout.example/api',
    fetch: fetchImpl,
  });
}

test('initial snapshot is loading with no session', () => {
  const store = newStore(stub(() => ({ json: {} })).fetch);
  const s = store.getSnapshot();
  assert.equal(s.phase, 'loading');
  assert.equal(s.session, null);
  assert.equal(s.busy, false);
});

test('load populates the session and moves to ready, notifying subscribers', async () => {
  const store = newStore(stub(() => ({ json: { id: 'cs_1', status: 'requires_payment_method' } })).fetch);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  await store.load();

  const s = store.getSnapshot();
  assert.equal(s.phase, 'ready');
  assert.equal(s.session?.id, 'cs_1');
  assert.equal(s.busy, false);
  assert.ok(notifications >= 2, 'busy toggled on then settled -> at least two notifications');
});

test('getSnapshot returns a stable reference until state changes', async () => {
  const store = newStore(stub(() => ({ json: { id: 'cs_1', status: 'ready' } })).fetch);
  const before = store.getSnapshot();
  assert.equal(store.getSnapshot(), before, 'same reference when unchanged');
  await store.load();
  assert.notEqual(store.getSnapshot(), before, 'new reference after a state change');
});

test('a mutating action stores the authoritative session the core returns', async () => {
  const s = stub((c) =>
    c.url.endsWith('/authorize')
      ? { json: { id: 'cs_1', status: 'requires_action' } }
      : { json: { id: 'cs_1', status: 'requires_payment_method' } },
  );
  const store = newStore(s.fetch);
  await store.load();

  const returned = await store.authorize({ expected_charge_amount: { value: 1500, currency: 'NGN' } } as never);
  assert.equal(returned.status, 'requires_action');
  assert.equal(store.getSnapshot().session?.status, 'requires_action');
  // The authorize call carried the client_secret and an idempotency key.
  const authCall = s.calls.find((c) => c.url.endsWith('/authorize'))!;
  assert.equal(authCall.headers['X-Client-Secret'], 'cs_secret');
  assert.ok(authCall.headers['Idempotency-Key']);
});

test('refreshMethods loads the ranked methods into state', async () => {
  const methods = [{ method: 'card', eligible: true }];
  const store = newStore(stub(() => ({ json: { data: methods } })).fetch);
  const out = await store.refreshMethods();
  assert.deepEqual(out, methods);
  assert.deepEqual(store.getSnapshot().methods, methods);
});

test('an error surfaces in state and rethrows, clearing busy', async () => {
  const coreErr: CoreError = {
    code: 'charge_amount_mismatch',
    category: 'idempotency',
    message_human: 'The total changed. Please review and try again.',
    message_machine: 'expected_charge_amount != live charge_amount',
    suggested_action: 'fix_request',
    retriable: false,
    session_status: 'requires_payment_method',
    request_id: 'req_1',
  };
  const store = newStore(stub(() => ({ status: 409, json: coreErr })).fetch);

  await assert.rejects(
    store.authorize({ expected_charge_amount: { value: 1, currency: 'NGN' } } as never),
    (e: unknown) => e instanceof CheckoutError && e.code === 'charge_amount_mismatch',
  );
  const s = store.getSnapshot();
  assert.ok(s.error instanceof CheckoutError);
  assert.equal(s.busy, false);
});

// --- Watching ----------------------------------------------------------------
//
// The store's watch is what replaces a polling loop in a React checkout, so what
// matters is that a snapshot is applied exactly as a read is, that a re-render
// cannot open a second connection, and that a snapshot arriving late never puts
// an older state back on screen.

/** A fetch stub that answers the read with JSON and the stream with SSE frames. */
function streamStub(read: unknown, frames: string[]) {
  const urls: string[] = [];
  const encoder = new TextEncoder();
  const fetchImpl = (async (url: string | URL) => {
    const target = String(url);
    urls.push(target);
    if (target.endsWith('/stream')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const f of frames) controller.enqueue(encoder.encode(f));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response(JSON.stringify(read), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls };
}

function frame(session: Record<string, unknown>): string {
  return `id: ${session['version']}\ndata: ${JSON.stringify(session)}\n\n`;
}

test('watch applies each snapshot the core sends and reports that it is watching', async () => {
  const s = streamStub({ id: 'cs_1', version: 1, status: 'processing' }, [
    frame({ id: 'cs_1', version: 2, status: 'pending' }),
    frame({ id: 'cs_1', version: 3, status: 'succeeded' }),
  ]);
  const store = newStore(s.fetch);
  await store.load();

  const seen: Array<string | undefined> = [];
  store.subscribe(() => seen.push(store.getSnapshot().session?.status));
  store.watch();
  assert.equal(store.getSnapshot().watching, true);

  await waitFor(() => store.getSnapshot().watching === false);
  assert.equal(store.getSnapshot().session?.status, 'succeeded');
  assert.ok(seen.includes('pending'), 'the intermediate state was applied, not just the last');
});

test('watching twice does not open a second connection', async () => {
  const s = streamStub({ id: 'cs_1', version: 1, status: 'pending' }, [
    frame({ id: 'cs_1', version: 2, status: 'succeeded' }),
  ]);
  const store = newStore(s.fetch);
  await store.load();

  const stopA = store.watch();
  const stopB = store.watch();
  await waitFor(() => store.getSnapshot().watching === false);
  stopA();
  stopB();

  assert.equal(s.urls.filter((u) => u.endsWith('/stream')).length, 1);
});

// The race this guards: an action returns version 4 while a version-3 snapshot is
// still in flight. Applying it in arrival order would walk the UI backwards.
test('a snapshot older than the state held is ignored', async () => {
  const s = streamStub({ id: 'cs_1', version: 4, status: 'succeeded' }, [
    frame({ id: 'cs_1', version: 3, status: 'processing' }),
  ]);
  const store = newStore(s.fetch);
  await store.load();
  store.watch();
  await waitFor(() => store.getSnapshot().watching === false);

  assert.equal(store.getSnapshot().session?.version, 4);
  assert.equal(store.getSnapshot().session?.status, 'succeeded');
});

test('stopping a watch clears the watching flag', async () => {
  const s = streamStub({ id: 'cs_1', version: 1, status: 'pending' }, []);
  const store = newStore(s.fetch);
  await store.load();
  const stop = store.watch();
  stop();
  await waitFor(() => store.getSnapshot().watching === false);
  assert.equal(store.getSnapshot().session?.version, 1);
});

/** Waits for a condition the watch resolves asynchronously, or fails the test. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before the deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// React's strict mode mounts, unmounts, and mounts again. If a stop left the store
// unable to re-watch, every strict-mode app would sit on a session that never
// updates — and it would look fine in production and broken only in development,
// or the reverse, depending on which one ran twice.
test('a watch stopped and started again ends up watching', async () => {
  const s = streamStub({ id: 'cs_1', version: 1, status: 'pending' }, [
    frame({ id: 'cs_1', version: 2, status: 'succeeded' }),
  ]);
  const store = newStore(s.fetch);
  await store.load();

  const stop = store.watch();
  stop();
  store.watch();

  await waitFor(() => store.getSnapshot().session?.status === 'succeeded');
  assert.equal(s.urls.filter((u) => u.endsWith('/stream')).length, 1, 'the stopped watch opened nothing');
});
