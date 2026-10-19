// Provenance verification for signed events and handoffs.
//
// Every event the core emits carries an Ed25519 signature and the `kid` of the
// signing key. The signature covers the RFC 8785 canonicalization of the event
// with the `signature` member removed — every other member, including `kid`, is
// signed, so the key id cannot be swapped. A verifier selects the published key
// whose `kid` matches (from the JWKS at GET /v1/signing_keys), recomputes the
// canonical bytes, and checks the signature. This provenance signature rides
// unchanged through the internal webhook service to the merchant, so origin can
// be confirmed end-to-end, independent of the webhook service's own
// merchant-facing transport signature (which is that service's contract, and is
// verified with a separate helper).
//
// This module uses Node's crypto and is intended for server-side use — webhooks
// are received and verified on a backend, never in a browser.
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './jcs.js';
import type { CheckoutClient } from './client.js';
import type { Event, SigningKeys } from './types.js';

/** Raised when an event's provenance cannot be established. Never treat a failed event as genuine. */
export class WebhookVerificationError extends Error {
  readonly name = 'WebhookVerificationError';
  /** A stable machine-readable reason for the failure. */
  readonly reason:
    | 'malformed'
    | 'unknown_kid'
    | 'bad_signature'
    | 'stale';

  constructor(reason: WebhookVerificationError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface WebhooksOptions {
  /**
   * How to obtain the published verification keys. Provide exactly one of:
   *  - `client`: fetch the JWKS from the core's signing_keys endpoint;
   *  - `fetchKeys`: a custom async fetcher (e.g. behind your own cache/CDN);
   *  - `keys`: a static JWKS you manage yourself.
   */
  client?: CheckoutClient;
  fetchKeys?: () => Promise<SigningKeys>;
  keys?: SigningKeys;
  /** How long a fetched key set is reused before a periodic refresh. Default 10 minutes. */
  cacheTtlMs?: number;
  /**
   * Freshness window for `created_at`. An event whose timestamp is outside
   * ±skew of now is rejected as stale (replay protection). Default 5 minutes,
   * matching the core's signing freshness window.
   */
  skewMs?: number;
  /** Injectable clock (milliseconds since epoch); defaults to Date.now. For tests. */
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SKEW_MS = 5 * 60 * 1000;

/**
 * Verifies the core's Ed25519 provenance signature on events, managing the
 * published key set: it caches the JWKS, refreshes it periodically, and — when
 * an event names a `kid` it has not seen — refreshes once so a rotated-in key
 * is trusted before it is first used to sign.
 */
export class Webhooks {
  readonly #fetchKeys: () => Promise<SigningKeys>;
  readonly #cacheTtlMs: number;
  readonly #skewMs: number;
  readonly #now: () => number;
  #cache: { keys: SigningKeys; fetchedAt: number } | undefined;

  constructor(options: WebhooksOptions) {
    const sources = [options.client, options.fetchKeys, options.keys].filter((s) => s !== undefined);
    if (sources.length !== 1) {
      throw new Error('Webhooks: provide exactly one of `client`, `fetchKeys`, or `keys`');
    }
    if (options.keys) {
      const keys = options.keys;
      this.#fetchKeys = () => Promise.resolve(keys);
    } else if (options.fetchKeys) {
      this.#fetchKeys = options.fetchKeys;
    } else {
      const client = options.client!;
      this.#fetchKeys = () => client.getSigningKeys();
    }
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#skewMs = options.skewMs ?? DEFAULT_SKEW_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Verify a received event and return it typed. Accepts the raw JSON body
   * string (recommended — verify before you trust the parse) or an already
   * parsed object. Throws WebhookVerificationError on any failure; a caller must
   * never act on an event this rejects.
   */
  async verify(payload: string | unknown): Promise<Event> {
    const event = parseEvent(payload);

    // Freshness first: a stale envelope is rejected regardless of signature, so
    // a captured-and-replayed event cannot be re-delivered indefinitely.
    assertFresh(event.created_at, this.#now(), this.#skewMs);

    let keys = await this.#keys();
    let jwk = findKey(keys, event.kid);
    if (!jwk && this.#cache) {
      // The kid is unknown to the cached set — a key may have just rotated in.
      // Force a single refresh before rejecting.
      keys = await this.#refresh();
      jwk = findKey(keys, event.kid);
    }
    if (!jwk) {
      throw new WebhookVerificationError(
        'unknown_kid',
        `no published key matches kid "${event.kid}"`,
      );
    }

    if (!verifySignature(event, jwk)) {
      throw new WebhookVerificationError('bad_signature', 'event signature does not verify');
    }
    return event;
  }

  async #keys(): Promise<SigningKeys> {
    if (this.#cache && this.#now() - this.#cache.fetchedAt < this.#cacheTtlMs) {
      return this.#cache.keys;
    }
    return this.#refresh();
  }

  async #refresh(): Promise<SigningKeys> {
    const keys = await this.#fetchKeys();
    this.#cache = { keys, fetchedAt: this.#now() };
    return keys;
  }
}

type Jwk = SigningKeys['keys'][number];

/**
 * Verify one event against one JWK, given you already hold the key. Recomputes
 * the canonical bytes over the event with `signature` removed and Ed25519-checks
 * the signature. Returns a boolean; it does not check freshness or key selection.
 */
export function verifySignature(event: Event, jwk: Jwk): boolean {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return false;
  const { signature, ...rest } = event as Record<string, unknown> & { signature: string };
  if (typeof signature !== 'string' || signature.length === 0) return false;

  let sig: Uint8Array;
  try {
    sig = new Uint8Array(Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }

  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    format: 'jwk',
  });

  let data: Uint8Array;
  try {
    data = canonicalBytes(rest);
  } catch {
    // A payload outside the signable domain (e.g. a non-integer number) can
    // never have been signed by the core; treat it as unverifiable.
    return false;
  }
  return edVerify(null, data, key, sig);
}

function findKey(keys: SigningKeys, kid: string): Jwk | undefined {
  return keys.keys.find((k) => k.kid === kid);
}

function parseEvent(payload: string | unknown): Event {
  let value: unknown;
  if (typeof payload === 'string') {
    try {
      value = JSON.parse(payload);
    } catch {
      throw new WebhookVerificationError('malformed', 'event body is not valid JSON');
    }
  } else {
    value = payload;
  }
  if (typeof value !== 'object' || value === null) {
    throw new WebhookVerificationError('malformed', 'event is not an object');
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== 'string' ||
    typeof v.kid !== 'string' ||
    typeof v.signature !== 'string' ||
    typeof v.created_at !== 'string'
  ) {
    throw new WebhookVerificationError('malformed', 'event is missing required signed fields');
  }
  return value as Event;
}

function assertFresh(createdAt: string, nowMs: number, skewMs: number): void {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) {
    throw new WebhookVerificationError('malformed', 'created_at is not a valid timestamp');
  }
  if (Math.abs(nowMs - t) > skewMs) {
    throw new WebhookVerificationError('stale', 'event created_at is outside the freshness window');
  }
}
