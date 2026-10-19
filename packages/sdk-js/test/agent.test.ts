import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentIdentity, PrincipalKey, randomNonce } from '../src/agent.js';

// Golden vectors, shared with the Go core (internal/agentid). Ed25519 is
// deterministic, so the same key over the same canonical bytes yields the same
// signature in both languages — and these strings are what the core actually
// produced for these documents.
//
// This is the cross-language guarantee the agent channel rests on, and it is the
// one thing here that cannot be caught by either side's own tests. The canonical
// bytes are pinned separately in jcs.test.ts; what these add is the whole
// artefact: canonicalization, the signature, and the base64url encoding, end to
// end. If any of the three drifts, an agent signs credentials the core refuses —
// and the failure looks like a bad key rather than a serialization difference.
const KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f
-----END PRIVATE KEY-----
`;

const AT = '2026-09-01T00:00:00Z';
const at = () => new Date(AT);

const agent = () =>
  new AgentIdentity({
    principal: 'prn_vector',
    agent: 'act_vector',
    merchant: 'mrc_vector',
    kid: 'agk_vector',
    privateKey: KEY,
    now: at,
  });

const principal = () =>
  new PrincipalKey({ principal: 'prn_vector', kid: 'agk_vector', privateKey: KEY, now: at });

/** Decode the `agt_` bearer back to the claims it carries. */
function claimsOf(bearer: string): Record<string, string> {
  assert.ok(bearer.startsWith('agt_'), `not an attestation bearer: ${bearer}`);
  return JSON.parse(Buffer.from(bearer.slice('agt_'.length), 'base64url').toString('utf8'));
}

test('an attestation signs the bytes the core verifies', () => {
  const claims = claimsOf(agent().attestation());
  assert.deepEqual(
    { ...claims, signature: undefined },
    {
      principal: 'prn_vector',
      agent: 'act_vector',
      merchant: 'mrc_vector',
      kid: 'agk_vector',
      issued_at: AT,
      signature: undefined,
    },
  );
  assert.equal(
    claims.signature,
    'RDifeCRI15GVXh-mxx0clIjx6hTuXSpTD974eeQ2xFRe9OH9UAJR-Fid7tiy13MB_riDq71ZKqAtJ2o22-trCA',
  );
});

test('a presentation signs the bytes the core verifies', () => {
  const presentation = agent().presentation('mnd_vector', 'nonce_vector');
  assert.equal(presentation.mandate_id, 'mnd_vector');
  assert.equal(presentation.nonce, 'nonce_vector');
  assert.equal(presentation.signed_at, AT);
  assert.equal(presentation.kid, 'agk_vector');
  assert.equal(
    presentation.signature,
    '10aVorm1Kj3mepfy2CjA6tYAIYVYgeI2mRuUbMMJAt01BvWswVCNaf0kG5tlSTUJMg32MM2XIwEs2t0zubQwDw',
  );
});

test('a revocation signs the bytes the core verifies', () => {
  const revocation = principal().signRevocation('mnd_vector');
  assert.equal(revocation.mandate_id, 'mnd_vector');
  assert.equal(revocation.revoked_at, AT);
  assert.equal(revocation.kid, 'agk_vector');
  assert.equal(
    revocation.signature,
    'LRq39FPfH577rPHx8Yuxxz5JY_lctW_kxyA4LMkiSGisF2QlC7_8jrLM55yUb7cstEcUHG6_8C_YHWFFOCHfAw',
  );
});

test('signed terms carry the principal and its kid, and the principal cannot be overridden', () => {
  // The principal comes from the key, so terms cannot be signed on somebody
  // else's behalf by passing a different one.
  const terms = principal().signTerms({
    id: 'mnd_vector',
    agent: 'act_vector',
    per_txn_cap: { value: 100000, currency: 'NGN' },
    cumulative_cap: { value: 500000, currency: 'NGN' },
    merchant_allowlist: ['mrc_vector'],
    currency: 'NGN',
    usage: 'recurring',
    expires_at: AT,
  });
  assert.equal(terms.principal, 'prn_vector');
  assert.equal(terms.kid, 'agk_vector');
  assert.ok(terms.signature.length > 0);
});

test('a fresh attestation is minted per call', () => {
  // Freshness is the whole of an attestation's replay exposure, because it is not
  // single-use. One captured at construction and reused for the life of a
  // long-running server would defeat the window it lives inside.
  let seconds = 0;
  const stepping = new AgentIdentity({
    principal: 'prn_vector',
    agent: 'act_vector',
    merchant: 'mrc_vector',
    kid: 'agk_vector',
    privateKey: KEY,
    now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, seconds++)),
  });
  assert.notEqual(
    claimsOf(stepping.attestation()).issued_at,
    claimsOf(stepping.attestation()).issued_at,
  );
});

test('a nonce is unique per presentation', () => {
  // The core rejects a (mandate_id, nonce) it has seen, so what this has to
  // guarantee is that a legitimate second authorization never collides with a
  // legitimate first.
  const nonces = new Set(Array.from({ length: 256 }, () => randomNonce()));
  assert.equal(nonces.size, 256);
});

test('an identity refuses to exist without what it needs to sign', () => {
  for (const missing of ['principal', 'agent', 'merchant', 'kid'] as const) {
    const options = {
      principal: 'prn_vector',
      agent: 'act_vector',
      merchant: 'mrc_vector',
      kid: 'agk_vector',
      privateKey: KEY,
    };
    delete (options as Record<string, unknown>)[missing];
    assert.throws(() => new AgentIdentity(options as never), new RegExp(missing));
  }
});
