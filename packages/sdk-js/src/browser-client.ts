// The browser client for Checkout. It authenticates with the session-scoped
// `client_secret` (the X-Client-Secret header) and exposes ONLY the verbs a
// browser may drive: it cannot create a session, read the event timeline, or
// read the collection confirmation, and it carries no agent-mandate authority.
// A `client_secret` is scoped to one session and drives it only until the
// session ends or expires. After that it reads that one session, while the buyer
// is finished with it and for a short window, and nothing else.
//
// This module imports nothing from `node:*`, so it bundles cleanly for the
// browser. Point `baseUrl` at the core (where CORS permits) or, more commonly,
// at a same-origin proxy that forwards the request with the client_secret — the
// pattern the hosted surface uses. Never put a merchant API key in a browser; use
// CheckoutClient (the server entry) for that.
import { SESSIONS, Transport, encodeId } from './http.js';
import { latestSnapshot, sessionSource, watchSnapshots } from './watch.js';
import type { SessionSource, WatchOptions } from './watch.js';
import type {
  AuthorizeRequest,
  CancelRequest,
  CheckoutSession,
  CompleteActionRequest,
  EligibleMethod,
  EligibleMethodsResponse,
  FxQuoteRequest,
  SelectMethodRequest,
  SetCustomerRequest,
  Surface,
} from './types.js';

/**
 * Which skin is driving. The core records the acting surface per action rather
 * than reading the session's origin, because the ordinary integration creates
 * the session on the merchant's server and collects from the buyer somewhere
 * else entirely.
 */
export type BrowserSurface = Extract<Surface, 'hosted' | 'embedded' | 'inline'>;

export interface CheckoutBrowserClientOptions {
  /** The session-scoped browser credential (`client_secret`). */
  clientSecret: string;
  /**
   * The surface these calls are driven from. Defaults to `inline`, which is what
   * this client is: an interface the merchant built themselves, over the session
   * the core owns. Set it only if you are driving a checkout of ours — a hosted
   * page or a drop-in frame — from your own code.
   *
   * Attribution, not authority: nothing about the payment turns on it. What it
   * decides is whose name is on each action in the session's own timeline, and
   * which surface the ranked method list is computed for. Sending nothing at all
   * would attribute every action a buyer took to whatever created the session,
   * which for the common integration is a server that never saw them.
   */
  surface?: BrowserSurface;
  /**
   * Base URL the client calls. Either the checkout API or a same-origin proxy
   * that forwards to it; in both cases the checkout-sessions paths are appended.
   */
  baseUrl: string;
  /** Injectable fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Idempotency-key generator for mutating calls. Default: a random UUID per call. */
  generateIdempotencyKey?: () => string;
}

export interface RequestOptions {
  /**
   * The idempotency key for this mutating call. Reuse the SAME key when retrying
   * the SAME logical action so a network-lost call is never re-executed; omit it
   * and the client generates a fresh one.
   */
  idempotencyKey?: string;
  /** An abort signal to cancel the request (combined with the client timeout). */
  signal?: AbortSignal;
}

export class CheckoutBrowserClient {
  readonly #http: Transport;

  constructor(options: CheckoutBrowserClientOptions) {
    if (!options.clientSecret) throw new Error('CheckoutBrowserClient: clientSecret is required');
    const clientSecret = options.clientSecret;
    const surface: BrowserSurface = options.surface ?? 'inline';
    this.#http = new Transport({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      authHeaders: () => ({ 'X-Client-Secret': clientSecret, 'X-Checkout-Surface': surface }),
      newIdempotencyKey: options.generateIdempotencyKey,
    });
  }

  /** Fetch the full current session state. */
  getSession(id: string, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#http.request<CheckoutSession>('GET', `${SESSIONS}/${encodeId(id)}`, {
      signal: opts.signal,
    });
  }

  /**
   * Watch the session's state, yielding each new snapshot as the core computes
   * it, until the buyer has nothing left to do.
   *
   * This is what a checkout you built yourself should hold open after authorize
   * instead of writing its own polling loop. It holds the core's session stream
   * and keeps a slow re-read beneath it, so a bank transfer that confirms or an
   * M-Pesa prompt the buyer approves moves the UI on within a second of the core
   * knowing — and still resolves if the connection was never made, was refused,
   * or died on a mobile network.
   *
   * ```ts
   * for await (const session of checkout.watchSession(id, { signal })) {
   *   render(session);
   * }
   * ```
   *
   * It stops by default once the buyer has nothing left to do, which includes
   * `awaiting_confirmation`: they have paid, the rail may take days, and holding
   * them on a spinner for it is the wrong screen. Show them the outcome is coming
   * — the session's `expected_resolution_at` says when — and let them close the
   * tab. Their merchant's server hears the outcome on the webhook regardless.
   *
   * Pass the `signal` of whatever owns the UI, so leaving the page ends the
   * watch. A `client_secret` is scoped to one session and expires with it, so a
   * watch that outlives the session simply ends.
   */
  watchSession(id: string, opts: WatchOptions = {}): AsyncGenerator<CheckoutSession, void, void> {
    return watchSnapshots(this.#watchSource(), id, opts);
  }

  /**
   * Watch until the buyer has nothing left to do, then return the last session
   * state seen.
   *
   * The returned session is not necessarily finished — an elapsed `timeoutMs` or
   * an aborted signal returns the newest snapshot as it stood, so read its
   * `status` and treat a live session as live. Prefer `watchSession` in a UI,
   * which lets you render each state on the way rather than only the last one.
   */
  waitForSession(id: string, opts: WatchOptions = {}): Promise<CheckoutSession> {
    return latestSnapshot(this.#watchSource(), id, opts);
  }

  /** The ranked eligible-methods list for the session (freshly computed, not the session snapshot). */
  async getEligibleMethods(id: string, opts: RequestOptions = {}): Promise<EligibleMethod[]> {
    const res = await this.#http.request<EligibleMethodsResponse>(
      'GET',
      `${SESSIONS}/${encodeId(id)}/methods`,
      { signal: opts.signal },
    );
    return res.data;
  }

  /**
   * Request a locked FX quote and re-lock the charge total. Not available yet:
   * the checkout API does not implement fx_quote and answers 501, raised here as
   * a CheckoutConnectionError, so no currency conversion is offered.
   */
  quoteFx(id: string, body: FxQuoteRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/fx_quote`, body, opts);
  }

  /** Choose one of the eligible methods (a method type plus, where applicable, the opaque vault token from client->vault capture — never raw instrument data). */
  selectMethod(id: string, body: SelectMethodRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/select_method`, body, opts);
  }

  /** Set or replace the buyer on the session before authorize (contact/locale only — no instrument data). */
  setCustomer(id: string, body: SetCustomerRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/set_customer`, body, opts);
  }

  /**
   * Start collection on the selected method. The caller MUST assert the exact
   * total it disclosed via `expected_charge_amount`; the core commits only if the
   * live `charge_amount` still matches and never silently re-quotes.
   */
  authorize(id: string, body: AuthorizeRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/authorize`, body, opts);
  }

  /** Submit the result of the session's current next_action (redirect/otp/stk_push/display_transfer_details/three_ds). */
  completeAction(id: string, body: CompleteActionRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/complete_action`, body, opts);
  }

  /** Cancel the session. Money in flight is resolved rail-side first — a discovered collection wins over the cancel. */
  cancel(id: string, body: CancelRequest = {}, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/cancel`, body, opts);
  }

  #mutate<T>(path: string, body: unknown, opts: RequestOptions): Promise<T> {
    return this.#http.request<T>('POST', path, {
      body,
      attachIdempotencyKey: true,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
  }

  #watchSource(): SessionSource {
    return sessionSource(this.#http);
  }
}
