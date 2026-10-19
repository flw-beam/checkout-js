import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/jcs.js';

// Golden vectors: the exact bytes the core's key-sorted, HTML-escaping-disabled
// JSON encoder produces over the same value. These pin cross-language parity —
// if this canonicalizer ever diverges from the signer, provenance verification
// silently breaks, so the vectors are the guard.
test('canonicalize sorts object keys lexicographically', () => {
  assert.equal(canonicalize({ b: 1, a: 'x' }), '{"a":"x","b":1}');
});

test('canonicalize sorts nested objects and preserves array order', () => {
  assert.equal(
    canonicalize({ z: [3, 2, 1], a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"z":[3,2,1]}',
  );
});

test('canonicalize emits no insignificant whitespace', () => {
  assert.equal(canonicalize({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
});

test('canonicalize handles the scalar forms', () => {
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(true), 'true');
  assert.equal(canonicalize(false), 'false');
  assert.equal(canonicalize(0), '0');
  assert.equal(canonicalize(-42), '-42');
  assert.equal(canonicalize('hello'), '"hello"');
});

test('canonicalize applies JSON string escaping without HTML escaping', () => {
  assert.equal(canonicalize('a"b\n'), '"a\\"b\\n"');
  // < > & are NOT escaped (matches the core's SetEscapeHTML(false)).
  assert.equal(canonicalize('<a>&'), '"<a>&"');
});

test('canonicalize drops undefined-valued keys', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
});

test('canonicalize rejects non-integer numbers (out of the signable domain)', () => {
  assert.throws(() => canonicalize(1.5), /non-integer number/);
  assert.throws(() => canonicalize(Number.NaN), /non-integer number/);
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), /non-integer number/);
});

test('canonicalize handles a representative event-shaped object', () => {
  const value = {
    id: 'evt_1',
    sequence: 2,
    version: 1,
    type: 'payment.succeeded',
    session_id: 'cs_1',
    created_at: '2026-07-28T10:00:00Z',
    kid: 'key-1',
    data: { amount: { value: 1500, currency: 'NGN' }, status: 'succeeded' },
  };
  assert.equal(
    canonicalize(value),
    '{"created_at":"2026-07-28T10:00:00Z","data":{"amount":{"currency":"NGN","value":1500},"status":"succeeded"},"id":"evt_1","kid":"key-1","sequence":2,"session_id":"cs_1","type":"payment.succeeded","version":1}',
  );
});
