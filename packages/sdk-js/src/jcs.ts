// Deterministic JSON canonicalization (RFC 8785, JSON Canonicalization Scheme):
// object keys sorted, no insignificant whitespace, exact number and string
// forms. The core signs the canonical bytes of an event with the `signature`
// member removed; a verifier recomputes the same bytes here and checks the
// Ed25519 signature. Signer and verifier share no code — only this scheme — so
// they must agree byte-for-byte.
//
// The signed payloads are drawn from a constrained domain: integer minor units
// (never floats), currency codes, ids, RFC 3339 timestamps, enum strings, all
// within the Basic Multilingual Plane. Over that domain, this recursive
// serializer is byte-identical to the core's key-sorted, HTML-escaping-disabled
// JSON encoder. A number that is not an exact integer is rejected rather than
// canonicalized to an ambiguous textual form — the same guard the signer
// applies — so a float can never be signed or verified inconsistently.

/** Canonicalize a JSON value to its RFC 8785 UTF-8 string form. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(
          `non-integer number ${String(value)} cannot be canonicalized deterministically`,
        );
      }
      // A JSON integer within the safe range round-trips exactly through String();
      // the core's payloads never exceed it.
      return String(value);

    case 'string':
      // JSON.stringify emits RFC 8785-conformant string escaping for this
      // ASCII/BMP domain (minimal escaping, no HTML escaping), matching the
      // core's encoder with HTML escaping disabled.
      return JSON.stringify(value);

    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      // Sort keys, dropping any whose value is undefined (which JSON has no
      // representation for and which never appears in a parsed payload).
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      const members = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
      return '{' + members.join(',') + '}';
    }

    default:
      // undefined, function, symbol, bigint — none can appear in a JSON payload.
      throw new Error(`value of type ${typeof value} cannot be canonicalized`);
  }
}

/** Canonical UTF-8 bytes for signing/verification. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
