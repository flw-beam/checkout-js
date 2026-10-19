import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalize } from '../src/jcs.js';
import { Webhooks, WebhookVerificationError, verifySignature } from '../src/webhooks.js';
import type { SigningKeys } from '../src/types.js';

// A fixed clock so freshness checks are deterministic.
const NOW = Date.parse('2026-07-28T10:00:00.000Z');
const now = () => NOW;

interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: SigningKeys['keys'][number];
}

function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const exported = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
  const jwk: SigningKeys['keys'][number] = {
    kid,
    kty: 'OKP',
    crv: 'Ed25519',
    x: exported.x,
    alg: 'EdDSA',
    use: 'sig',
  };
  return { kid, privateKey, jwk };
}

// Sign an event exactly as the core does: stamp the kid, canonicalize the
// envelope WITHOUT the signature member, Ed25519-sign, attach the base64url
// signature. An independent signer proving the verifier round-trips.
function signEvent(
  key: TestKey,
  overrides: Record<string, unknown> = {},
  createdAtMs: number = NOW,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    id: 'evt_1',
    sequence: 1,
    version: 1,
    type: 'payment.succeeded',
    session_id: 'cs_1',
    created_at: new Date(createdAtMs).toISOString(),
    data: { amount: { value: 1500, currency: 'NGN' }, status: 'succeeded' },
    kid: key.kid,
    ...overrides,
  };
  const bytes = new TextEncoder().encode(canonicalize(event));
  event.signature = sign(null, bytes, key.privateKey).toString('base64url');
  return event;
}

function jwks(...keys: TestKey[]): SigningKeys {
  return { keys: keys.map((k) => k.jwk) };
}

test('verify accepts a genuinely signed event', async () => {
  const key = makeKey('key-1');
  const event = signEvent(key);
  const wh = new Webhooks({ keys: jwks(key), now });
  const verified = await wh.verify(JSON.stringify(event));
  assert.equal(verified.id, 'evt_1');
});

test('verify accepts an already-parsed event object', async () => {
  const key = makeKey('key-1');
  const event = signEvent(key);
  const wh = new Webhooks({ keys: jwks(key), now });
  const verified = await wh.verify(event);
  assert.equal(verified.type, 'payment.succeeded');
});

test('verify rejects a tampered payload', async () => {
  const key = makeKey('key-1');
  const event = signEvent(key);
  event.session_id = 'cs_tampered'; // change a signed field after signing
  const wh = new Webhooks({ keys: jwks(key), now });
  await assert.rejects(wh.verify(event), (e: unknown) => {
    assert.ok(e instanceof WebhookVerificationError);
    assert.equal(e.reason, 'bad_signature');
    return true;
  });
});

test('verify rejects a swapped kid (kid is part of the signed bytes)', async () => {
  const a = makeKey('key-a');
  const b = makeKey('key-b');
  const event = signEvent(a);
  event.kid = 'key-b'; // point at another published key; signature was over key-a
  const wh = new Webhooks({ keys: jwks(a, b), now });
  await assert.rejects(wh.verify(event), (e: unknown) => {
    assert.ok(e instanceof WebhookVerificationError);
    assert.equal(e.reason, 'bad_signature');
    return true;
  });
});

test('verify rejects an unknown kid', async () => {
  const key = makeKey('key-1');
  const other = makeKey('key-2');
  const event = signEvent(key);
  const wh = new Webhooks({ keys: jwks(other), now });
  await assert.rejects(wh.verify(event), (e: unknown) => {
    assert.ok(e instanceof WebhookVerificationError);
    assert.equal(e.reason, 'unknown_kid');
    return true;
  });
});

test('verify refreshes once to pick up a rotated-in key', async () => {
  const oldKey = makeKey('key-old');
  const newKey = makeKey('key-new');
  const event = signEvent(newKey); // signed by a key not yet in the cached set

  let calls = 0;
  const fetchKeys = () => {
    calls += 1;
    // First fetch has only the old key; after rotation the new key appears.
    return Promise.resolve(calls === 1 ? jwks(oldKey) : jwks(oldKey, newKey));
  };
  const wh = new Webhooks({ fetchKeys, now });
  const verified = await wh.verify(event);
  assert.equal(verified.id, 'evt_1');
  assert.equal(calls, 2, 'should refresh exactly once on an unknown kid');
});

test('verify rejects a stale event outside the freshness window', async () => {
  const key = makeKey('key-1');
  const event = signEvent(key, {}, NOW - 10 * 60 * 1000); // 10 min old, default skew 5 min
  const wh = new Webhooks({ keys: jwks(key), now });
  await assert.rejects(wh.verify(event), (e: unknown) => {
    assert.ok(e instanceof WebhookVerificationError);
    assert.equal(e.reason, 'stale');
    return true;
  });
});

test('verify rejects malformed input', async () => {
  const key = makeKey('key-1');
  const wh = new Webhooks({ keys: jwks(key), now });
  await assert.rejects(wh.verify('not json'), (e: unknown) => {
    assert.ok(e instanceof WebhookVerificationError);
    assert.equal(e.reason, 'malformed');
    return true;
  });
  await assert.rejects(wh.verify({ id: 'evt_1' }), (e: unknown) => {
    assert.ok(e instanceof WebhookVerificationError);
    assert.equal(e.reason, 'malformed');
    return true;
  });
});

test('verifySignature returns false against the wrong key', () => {
  const key = makeKey('key-1');
  const wrong = makeKey('key-2');
  const event = signEvent(key);
  // Present the wrong key under the event's kid.
  const spoofed = { ...wrong.jwk, kid: key.kid };
  assert.equal(verifySignature(event as never, spoofed), false);
});

test('Webhooks requires exactly one key source', () => {
  assert.throws(() => new Webhooks({}), /exactly one/);
});
