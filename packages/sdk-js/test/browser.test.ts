import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutBrowserClient } from '../src/browser.js';
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
  text?: string;
  headers?: Record<string, string>;
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
    const status = r.status ?? 200;
    const body = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
    return new Response(body, { status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const BASE = 'https://checkout.example/api';

function newClient(fetchImpl: typeof fetch) {
  return new CheckoutBrowserClient({ clientSecret: 'cs_secret_abc', baseUrl: BASE, fetch: fetchImpl });
}

const SESSION = { id: 'cs_1', status: 'requires_payment_method' };

test('mutating calls carry the X-Client-Secret header and an idempotency key, never a bearer token', async () => {
  const s = stub(() => ({ json: SESSION }));
  const client = newClient(s.fetch);
  await client.selectMethod('cs_1', { method: 'card' } as never);

  const call = s.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${BASE}/v1/checkout_sessions/cs_1/select_method`);
  assert.equal(call.headers['X-Client-Secret'], 'cs_secret_abc');
  assert.equal(call.headers['Authorization'], undefined, 'a browser client must never send a bearer merchant key');
  assert.ok(call.headers['Idempotency-Key']);
});

// A browser driving its own interface over this client is the `inline` surface,
// and saying so is what puts the buyer's own actions in the session timeline
// under the page they were on. Sending nothing would attribute all of them to
// whatever created the session — for the ordinary integration, a server that
// never saw the buyer.
test('every call names the surface, defaulting to the one this client is', async () => {
  const s = stub(() => ({ json: SESSION }));
  const client = newClient(s.fetch);
  await client.getSession('cs_1');
  await client.selectMethod('cs_1', { method: 'card' } as never);

  assert.equal(s.calls[0]!.headers['X-Checkout-Surface'], 'inline');
  assert.equal(s.calls[1]!.headers['X-Checkout-Surface'], 'inline');
});

test('a client driving a checkout of ours declares that surface instead', async () => {
  const s = stub(() => ({ json: SESSION }));
  const client = new CheckoutBrowserClient({
    clientSecret: 'cs_secret_abc',
    baseUrl: BASE,
    fetch: s.fetch,
    surface: 'embedded',
  });
  await client.getSession('cs_1');

  assert.equal(s.calls[0]!.headers['X-Checkout-Surface'], 'embedded');
});

test('a provided idempotency key is used verbatim on authorize', async () => {
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

test('getSession is a keyless, bodyless GET', async () => {
  const s = stub(() => ({ json: SESSION }));
  const client = newClient(s.fetch);
  const out = await client.getSession('cs_1');
  assert.equal(s.calls[0]!.method, 'GET');
  assert.equal(s.calls[0]!.headers['Idempotency-Key'], undefined);
  assert.equal(s.calls[0]!.body, undefined);
  assert.deepEqual(out, SESSION);
});

test('getEligibleMethods unwraps the data envelope', async () => {
  const methods = [{ method: 'mobile_money', eligible: true }];
  const s = stub(() => ({ json: { data: methods } }));
  const client = newClient(s.fetch);
  const out = await client.getEligibleMethods('cs_1');
  assert.equal(s.calls[0]!.url, `${BASE}/v1/checkout_sessions/cs_1/methods`);
  assert.deepEqual(out, methods);
});

test('the browser client exposes no create/confirmation/events verbs', () => {
  const client = newClient(stub(() => ({ json: SESSION })).fetch) as unknown as Record<string, unknown>;
  // These are not permitted with a client_secret and must not exist on the client.
  assert.equal(typeof client.createSession, 'undefined');
  assert.equal(typeof client.getConfirmation, 'undefined');
  assert.equal(typeof client.listEvents, 'undefined');
});

test('a stable Error response becomes a CheckoutError', async () => {
  const coreErr: CoreError = {
    code: 'session_not_cancelable',
    category: 'validation',
    message_human: 'This session can no longer be canceled.',
    message_machine: 'session terminal',
    suggested_action: 'none',
    retriable: false,
    session_status: 'succeeded',
    request_id: 'req_9',
  };
  const s = stub(() => ({ status: 409, json: coreErr }));
  const client = newClient(s.fetch);
  await assert.rejects(client.cancel('cs_1'), (e: unknown) => {
    assert.ok(e instanceof CheckoutError);
    assert.equal(e.code, 'session_not_cancelable');
    assert.equal(e.status, 409);
    return true;
  });
});
