import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutClient } from '../src/client.js';
import { CheckoutError, CheckoutConnectionError } from '../src/errors.js';
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
  text?: string;
  headers?: Record<string, string>;
}

// A fetch stub that records each request and returns a canned response, so the
// client's transport behaviour (auth, idempotency, serialization, error mapping)
// is asserted without a live core.
function stub(responder: (c: Captured) => StubResponse) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(captured);
    const r = responder(captured);
    const status = r.status ?? 200;
    const body = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
    return new Response(body, { status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const BASE = 'https://api.flutterwave.test/checkout';

function newClient(fetchImpl: typeof fetch) {
  return new CheckoutClient({ apiKey: 'sk_test_123', baseUrl: BASE, fetch: fetchImpl });
}

const SESSION = { id: 'cs_1', status: 'ready' };

test('createSession posts with bearer auth, an auto idempotency key, and a JSON body', async () => {
  const s = stub(() => ({ status: 201, json: SESSION }));
  const client = newClient(s.fetch);
  const body = {
    amount: { value: 1500, currency: 'NGN' },
    line_items: [{ name: 'x', amount: { value: 1500, currency: 'NGN' }, quantity: 1 }],
    actor: { type: 'merchant_server' },
    origin_surface: 'hosted',
  };
  const out = await client.createSession(body as never);

  const call = s.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${BASE}/v1/checkout_sessions`);
  assert.equal(call.headers['Authorization'], 'Bearer sk_test_123');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.ok(call.headers['Idempotency-Key'], 'an idempotency key is generated');
  assert.deepEqual(JSON.parse(call.body!), body);
  assert.deepEqual(out, SESSION);
});

test('a provided idempotency key is used verbatim', async () => {
  const s = stub(() => ({ json: SESSION }));
  const client = newClient(s.fetch);
  await client.authorize(
    'cs_1',
    { expected_charge_amount: { value: 1500, currency: 'NGN' } } as never,
    { idempotencyKey: 'fixed-key-1' },
  );
  assert.equal(s.calls[0]!.headers['Idempotency-Key'], 'fixed-key-1');
  assert.equal(s.calls[0]!.url, `${BASE}/v1/checkout_sessions/cs_1/authorize`);
});

test('getSession is a GET with no idempotency key or body', async () => {
  const s = stub(() => ({ json: SESSION }));
  const client = newClient(s.fetch);
  const out = await client.getSession('cs_1');
  assert.equal(s.calls[0]!.method, 'GET');
  assert.equal(s.calls[0]!.headers['Idempotency-Key'], undefined);
  assert.equal(s.calls[0]!.body, undefined);
  assert.deepEqual(out, SESSION);
});

test('getEligibleMethods unwraps the data envelope', async () => {
  const methods = [{ method: 'card', eligible: true }];
  const s = stub(() => ({ json: { data: methods } }));
  const client = newClient(s.fetch);
  const out = await client.getEligibleMethods('cs_1');
  assert.equal(s.calls[0]!.url, `${BASE}/v1/checkout_sessions/cs_1/methods`);
  assert.deepEqual(out, methods);
});

test('listEvents encodes cursor and limit as query params', async () => {
  const s = stub(() => ({ json: { data: [], has_more: false, next_cursor: null } }));
  const client = newClient(s.fetch);
  await client.listEvents('cs_1', { cursor: 'abc', limit: 25 });
  assert.equal(s.calls[0]!.url, `${BASE}/v1/checkout_sessions/cs_1/events?cursor=abc&limit=25`);
});

test('listSessions sends every filter as a query param and never a body', async () => {
  const s = stub(() => ({ json: { data: [SESSION], has_more: false, next_cursor: null } }));
  const client = newClient(s.fetch);
  const out = await client.listSessions({
    cursor: 'abc',
    limit: 10,
    status: 'succeeded',
    method: 'card',
    currency: 'NGN',
    collectionRef: 'col_1',
    createdAfter: '2026-01-01T00:00:00Z',
  });

  const call = s.calls[0]!;
  assert.equal(call.method, 'GET');
  assert.equal(call.body, undefined);
  assert.equal(call.headers['Idempotency-Key'], undefined, 'a read carries no idempotency key');
  const url = new URL(call.url);
  assert.equal(url.pathname, '/checkout/v1/checkout_sessions');
  assert.equal(url.searchParams.get('collection_ref'), 'col_1');
  assert.equal(url.searchParams.get('created_after'), '2026-01-01T00:00:00Z');
  assert.equal(url.searchParams.get('status'), 'succeeded');
  assert.deepEqual(out.data, [SESSION]);
});

test('replaySession posts to the source session and carries an idempotency key', async () => {
  // A retried click must not litter test mode with duplicates of one payment,
  // which is what the key on this mutating call is for.
  const s = stub(() => ({ status: 201, json: { ...SESSION, id: 'cs_2', livemode: false, replay_of: 'cs_1' } }));
  const client = newClient(s.fetch);
  const out = await client.replaySession('cs_1');

  const call = s.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${BASE}/v1/checkout_sessions/cs_1/replay`);
  assert.ok(call.headers['Idempotency-Key']);
  // Nothing the caller could send would restate the shape, so nothing is sent.
  assert.deepEqual(JSON.parse(call.body!), {});
  assert.equal((out as { replay_of?: string }).replay_of, 'cs_1');
});

test('getRailHealth unwraps the data envelope and narrows to a market', async () => {
  const health = [{ method: 'mobile_money', status: 'degraded', observed_at: '2026-01-01T00:00:00Z' }];
  const s = stub(() => ({ json: { data: health } }));
  const client = newClient(s.fetch);
  const out = await client.getRailHealth({ currency: 'KES', country: 'KE' });
  assert.equal(s.calls[0]!.url, `${BASE}/v1/rail_health?currency=KES&country=KE`);
  assert.deepEqual(out, health);
});

test('a stable Error response becomes a CheckoutError with the fields and Retry-After', async () => {
  const coreErr: CoreError = {
    code: 'idempotency_conflict',
    category: 'idempotency',
    message_human: 'That request is already in progress.',
    message_machine: 'concurrent request holds the idempotency key',
    suggested_action: 'retry',
    retriable: true,
    session_status: 'ready',
    request_id: 'req_1',
  };
  const s = stub(() => ({ status: 409, json: coreErr, headers: { 'Retry-After': '3' } }));
  const client = newClient(s.fetch);
  await assert.rejects(
    client.authorize('cs_1', { expected_charge_amount: { value: 1, currency: 'NGN' } } as never),
    (e: unknown) => {
      assert.ok(e instanceof CheckoutError);
      assert.equal(e.status, 409);
      assert.equal(e.code, 'idempotency_conflict');
      assert.equal(e.category, 'idempotency');
      assert.equal(e.retriable, true);
      assert.equal(e.retryAfter, 3);
      assert.equal(e.requestId, 'req_1');
      return true;
    },
  );
});

test('a non-Error error body becomes a CheckoutConnectionError', async () => {
  const s = stub(() => ({ status: 502, text: '<html>bad gateway</html>' }));
  const client = newClient(s.fetch);
  await assert.rejects(client.getSession('cs_1'), (e: unknown) => {
    assert.ok(e instanceof CheckoutConnectionError);
    assert.equal(e.status, 502);
    return true;
  });
});

test('a transport failure becomes a CheckoutConnectionError', async () => {
  const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
  const client = newClient(fetchImpl);
  await assert.rejects(client.getSession('cs_1'), (e: unknown) => {
    assert.ok(e instanceof CheckoutConnectionError);
    return true;
  });
});
