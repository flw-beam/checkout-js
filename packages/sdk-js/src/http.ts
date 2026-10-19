// The shared HTTP transport both clients sit on. It is runtime-agnostic — it
// uses only fetch, AbortSignal, URLSearchParams, and Web Crypto (all available
// in Node >=20 and modern browsers) and imports nothing from `node:*`, so the
// browser client that builds on it can bundle without pulling a Node-only
// dependency. Auth is injected per caller (a merchant API key bearer header on
// the server client, the X-Client-Secret header on the browser client); the
// transport itself carries no payment logic.
import { CheckoutConnectionError, CheckoutError, isCoreError } from './errors.js';

/** The checkout-sessions path prefix on the core API. */
export const SESSIONS = '/v1/checkout_sessions';

/**
 * The mandates path prefix. Scoped to a mandate rather than a session, because a
 * mandate outlives any one of them — a recurring mandate is the authority behind
 * many.
 */
export const MANDATES = '/v1/mandates';

/** URL-encode a session id for safe use in a path segment. */
export function encodeId(id: string): string {
  return encodeURIComponent(id);
}

export interface TransportOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Credential headers to attach to every request (evaluated per call). */
  authHeaders: () => Record<string, string>;
  /** Idempotency-key generator for mutating calls. Default: a random UUID. */
  newIdempotencyKey?: () => string;
}

export interface SendOptions {
  body?: unknown;
  /** An explicit idempotency key (reused across retries of the same logical action). */
  idempotencyKey?: string;
  /** When true, attach an idempotency key (the explicit one, else a generated one). */
  attachIdempotencyKey?: boolean;
  query?: URLSearchParams;
  signal?: AbortSignal;
}

export interface StreamOptions {
  /** Extra request headers (the SSE resume header, where one applies). */
  headers?: Record<string, string>;
  /** Ends the connection. Required: an open-ended read must always have an owner. */
  signal: AbortSignal;
}

export class Transport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #authHeaders: () => Record<string, string>;
  readonly #newKey: () => string;

  constructor(options: TransportOptions) {
    if (!options.baseUrl) throw new Error('Transport: baseUrl is required');
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#authHeaders = options.authHeaders;
    this.#newKey = options.newIdempotencyKey ?? (() => globalThis.crypto.randomUUID());
  }

  async request<T>(method: string, path: string, opts: SendOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...this.#authHeaders(),
      Accept: 'application/json',
    };
    if (opts.attachIdempotencyKey) {
      headers['Idempotency-Key'] = opts.idempotencyKey ?? this.#newKey();
    }
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }

    const suffix = opts.query && [...opts.query].length > 0 ? `?${opts.query.toString()}` : '';

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}${suffix}`, {
        method,
        headers,
        body: payload,
        signal: combineSignal(opts.signal, this.#timeoutMs),
      });
    } catch (cause) {
      throw new CheckoutConnectionError(`request to the checkout core failed: ${errText(cause)}`, {
        cause,
      });
    }

    const text = await res.text();

    if (!res.ok) throw errorFor(res, text);

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new CheckoutConnectionError('checkout core returned an unparseable success body', {
        status: res.status,
        cause,
      });
    }
  }

  /**
   * Opens a long-lived Server-Sent Events read and hands back the live response,
   * for a caller that consumes the body as it arrives.
   *
   * Deliberately not `request`: that reads the whole body before returning, which
   * for a stream means returning when it ends. The client timeout is not applied
   * either — a request deadline would cut a healthy connection at 30 seconds, and
   * a stream that is waiting on a rail is *supposed* to be quiet. The caller owns
   * the connection's lifetime through `signal`, and the session watch bounds
   * silence with its own stall timer instead.
   *
   * An error response is mapped exactly as it is on a request, so a caller sees
   * the same CheckoutError it would from a read.
   */
  async openStream(path: string, opts: StreamOptions): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'GET',
        headers: { ...this.#authHeaders(), ...opts.headers, Accept: 'text/event-stream' },
        signal: opts.signal,
      });
    } catch (cause) {
      throw new CheckoutConnectionError(`stream to the checkout core failed: ${errText(cause)}`, {
        cause,
      });
    }
    if (!res.ok) throw errorFor(res, await res.text());
    return res;
  }
}

// Maps a non-OK response onto the SDK's error types: the core's stable Error
// shape as a CheckoutError, anything else as a connection error, so a caller
// never has to tell an infrastructure 502 from a decline by reading a body.
function errorFor(res: Response, text: string): CheckoutError | CheckoutConnectionError {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return new CheckoutConnectionError(
      `checkout core returned a non-JSON error body (status ${res.status})`,
      { status: res.status },
    );
  }
  if (!isCoreError(parsed)) {
    return new CheckoutConnectionError(
      `checkout core returned an unexpected error shape (status ${res.status})`,
      { status: res.status },
    );
  }
  return new CheckoutError(res.status, parsed, parseRetryAfter(res.headers.get('retry-after')));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

// Combine an optional caller signal with a timeout so a hung dependency can
// never hang the caller, while still honoring an explicit cancel.
function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
