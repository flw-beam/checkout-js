// The typed server client for the Checkout collection API. It carries no
// payment logic — it sends the canonical verbs and returns the session the core
// computed, or the stable Error shape as a CheckoutError. Server-side only: it
// authenticates with the merchant's Dashboard API key, which must never reach a
// browser (browser surfaces use the session-scoped client_secret via
// CheckoutBrowserClient).
import { MANDATES, SESSIONS, Transport, encodeId } from './http.js';
import { latestSnapshot, sessionSource, watchSnapshots } from './watch.js';
import type { SessionSource, WatchOptions } from './watch.js';
import type {
  AuthorizeRequest,
  CancelRequest,
  CheckoutSession,
  CollectionConfirmation,
  CompleteActionRequest,
  CreateSessionRequest,
  EligibleMethod,
  EligibleMethodsResponse,
  EventFeedResponse,
  EventsResponse,
  FxQuoteRequest,
  Mandate,
  MandateRevocation,
  RailHealth,
  RailHealthResponse,
  SessionListResponse,
  SelectMethodRequest,
  SetCustomerRequest,
  SigningKeys,
} from './types.js';

export interface CheckoutClientOptions {
  /** The merchant's Dashboard API key, presented as a bearer token. */
  apiKey: string;
  /**
   * Base URL of the checkout API for your environment: the host only, since the
   * client appends each operation's `/v1/...` path. There is no default.
   */
  baseUrl: string;
  /** Injectable fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 30000. A hung rail must never hang a caller. */
  timeoutMs?: number;
  /** Idempotency-key generator for mutating calls. Default: a random UUID per call. */
  generateIdempotencyKey?: () => string;
}

export interface RequestOptions {
  /**
   * The idempotency key for this mutating call. Reuse the SAME key when retrying
   * the SAME logical action so a network-lost call is never re-executed; omit it
   * and the client generates a fresh one (a new logical action).
   */
  idempotencyKey?: string;
  /** An abort signal to cancel the request (combined with the client timeout). */
  signal?: AbortSignal;
}

export class CheckoutClient {
  readonly #http: Transport;

  constructor(options: CheckoutClientOptions) {
    if (!options.apiKey) throw new Error('CheckoutClient: apiKey is required');
    const apiKey = options.apiKey;
    this.#http = new Transport({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      authHeaders: () => ({ Authorization: `Bearer ${apiKey}` }),
      newIdempotencyKey: options.generateIdempotencyKey,
    });
  }

  // --- Session lifecycle ----------------------------------------------------

  /** Create a session from a merchant intent. Returns the full session (with the one-time client_secret). */
  createSession(body: CreateSessionRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(SESSIONS, body, opts);
  }

  /**
   * A page of this merchant's sessions, newest first — the read behind a payment
   * list and its search.
   *
   * Scoped to the `(merchant, livemode)` of the API key you present; every
   * filter only narrows that, and none can widen it. Distinct from
   * `listMerchantEvents`, which pages events and ages them out: this pages
   * sessions and is not retention-bounded, so it is what answers "which sessions
   * match X". Listed sessions never carry a `client_secret`.
   *
   * `next_cursor` is null once the page reached the oldest match. Paging runs
   * backwards through history, so a session created while you page arrives at the
   * front rather than in a page you have already read.
   */
  listSessions(
    params: {
      cursor?: string;
      limit?: number;
      status?: string;
      method?: string;
      currency?: string;
      collectionRef?: string;
      createdAfter?: string;
      createdBefore?: string;
    } = {},
    opts: RequestOptions = {},
  ): Promise<SessionListResponse> {
    const query = new URLSearchParams();
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.status !== undefined) query.set('status', params.status);
    if (params.method !== undefined) query.set('method', params.method);
    if (params.currency !== undefined) query.set('currency', params.currency);
    if (params.collectionRef !== undefined) query.set('collection_ref', params.collectionRef);
    if (params.createdAfter !== undefined) query.set('created_after', params.createdAfter);
    if (params.createdBefore !== undefined) query.set('created_before', params.createdBefore);
    return this.#http.request<SessionListResponse>('GET', SESSIONS, { query, signal: opts.signal });
  }

  /** Fetch the full current session state. */
  getSession(id: string, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#http.request<CheckoutSession>('GET', `${SESSIONS}/${encodeId(id)}`, {
      signal: opts.signal,
    });
  }

  /**
   * Watch one session's state, yielding each new snapshot as the core computes
   * it, until the buyer has nothing left to do.
   *
   * This is what replaces a polling loop. It holds the core's session stream open
   * and keeps a slow re-read beneath it, so an outcome lands promptly without
   * either hammering the API or resting on one long-lived connection. The first
   * value is always the session as it stands now, and every value is the same
   * CheckoutSession `getSession` returns.
   *
   * ```ts
   * for await (const session of checkout.watchSession(id)) {
   *   console.log(session.status);
   * }
   * ```
   *
   * Not a substitute for a webhook. A watch lives as long as the process that
   * started it, so a server that learns outcomes only this way loses them on a
   * restart or a deploy: `payment.succeeded` is the integration, committed with
   * the transition itself and delivered with retries behind it. Reach for a watch
   * when something is *waiting* on this one session — a script, a job, a
   * merchant-built UI on an async rail.
   *
   * Intermediate states may be skipped when transitions land faster than the
   * watch drains, so branch on the snapshot you hold rather than counting the
   * ones you were handed.
   */
  watchSession(id: string, opts: WatchOptions = {}): AsyncGenerator<CheckoutSession, void, void> {
    return watchSnapshots(this.#watchSource(), id, opts);
  }

  /**
   * Watch until the buyer has nothing left to do, then return the last session
   * state seen — the one-line form for a script or a backend job whose only
   * remaining job is to wait.
   *
   * The returned session is not necessarily finished: an elapsed `timeoutMs` or
   * an aborted signal returns the newest snapshot as it stood, which is why this
   * hands back a session rather than throwing. Read its `status`. A session still
   * live at that point is still live — the money may yet arrive, the core
   * resolves it by status inquiry, and the outcome comes as an event. Treating a
   * deadline as a failure is how an integration cancels an order for a buyer who
   * was charged.
   */
  waitForSession(id: string, opts: WatchOptions = {}): Promise<CheckoutSession> {
    return latestSnapshot(this.#watchSource(), id, opts);
  }

  /** The ranked eligible-methods list for a session. */
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

  /** Choose one of the eligible methods (carries a method type and an opaque vault token where applicable — never raw instrument data). */
  selectMethod(id: string, body: SelectMethodRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/select_method`, body, opts);
  }

  /** Set or replace the buyer on a live session (contact/locale only — no instrument data). */
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

  /** Cancel a session. Money in flight is resolved rail-side first — a discovered collection wins over the cancel. */
  cancel(id: string, body: CancelRequest = {}, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/cancel`, body, opts);
  }

  /**
   * Reconstruct a session's disclosed shape — amount, line items,
   * merchant-declared fees and tax, method, market, surface — as a NEW test-mode
   * session, so the same collection can be driven again against the test rail.
   *
   * The returned session is always `livemode: false` and carries `replay_of`. The
   * source session is not modified, and the buyer, metadata, instrument
   * reference, FX quote and attempt history are deliberately not copied: this is
   * a fresh session asking for the same total, not a copy of a payment. Supply
   * the test buyer with `setCustomer` as you would for any session.
   *
   * There is nothing to pass: everything replayed comes from the source. To
   * reproduce a failure rather than only a shape, pay the replay with the test
   * rail's own test value for that failure (see the test-mode guide). Drive the
   * result with a TEST-mode key: a live key sees it once, here.
   */
  replaySession(id: string, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/replay`, {}, opts);
  }

  // --- Read-only timeline & keys --------------------------------------------

  /** The checkout-owned collection confirmation (NOT a financial receipt). 409 until the session is succeeded. */
  getConfirmation(id: string, opts: RequestOptions = {}): Promise<CollectionConfirmation> {
    return this.#http.request<CollectionConfirmation>('GET', `${SESSIONS}/${encodeId(id)}/confirmation`, {
      signal: opts.signal,
    });
  }

  /** A page of the session event timeline (oldest-first per session), without any downstream financial state. */
  listEvents(id: string, params: { cursor?: string; limit?: number } = {}, opts: RequestOptions = {}): Promise<EventsResponse> {
    const query = new URLSearchParams();
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    return this.#http.request<EventsResponse>('GET', `${SESSIONS}/${encodeId(id)}/events`, {
      query,
      signal: opts.signal,
    });
  }

  /**
   * A page of this merchant's events across sessions, in cursor order.
   *
   * Scoped to the `(merchant, livemode)` of the API key you present — a browser
   * `client_secret` cannot read it, and neither can an agent credential. Reading
   * forward from a `next_cursor` returns every subsequent event exactly once, so
   * persisting the cursor is enough to resume without gaps.
   *
   * This is for reconciliation and backfill, not for receiving events in
   * production: webhooks are the integration, with delivery retries behind them.
   * Events also age out of the feed, so use `listEvents` for one session's full
   * history.
   */
  listMerchantEvents(
    params: { cursor?: string; limit?: number; type?: string; sessionId?: string } = {},
    opts: RequestOptions = {},
  ): Promise<EventFeedResponse> {
    const query = new URLSearchParams();
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.type !== undefined) query.set('type', params.type);
    if (params.sessionId !== undefined) query.set('session_id', params.sessionId);
    return this.#http.request<EventFeedResponse>('GET', '/v1/events', {
      query,
      signal: opts.signal,
    });
  }

  /**
   * Current health of each payment method's rails.
   *
   * Platform state, identical for every caller and carrying no session or
   * merchant data. Advisory: routing already applies this signal and ranks
   * capacity rather than withdrawing it, so a `degraded` method still collects.
   * To know whether one session may use a method, read that session's
   * `eligible_methods`. Narrow to a market with `currency`/`country`.
   */
  async getRailHealth(
    params: { currency?: string; country?: string } = {},
    opts: Pick<RequestOptions, 'signal'> = {},
  ): Promise<RailHealth[]> {
    const query = new URLSearchParams();
    if (params.currency !== undefined) query.set('currency', params.currency);
    if (params.country !== undefined) query.set('country', params.country);
    const res = await this.#http.request<RailHealthResponse>('GET', '/v1/rail_health', {
      query,
      signal: opts.signal,
    });
    return res.data;
  }

  /** The published Ed25519 verification keys (JWKS) for event/handoff provenance signatures. */
  /**
   * Read one of this merchant's agent mandates: the principal's signed terms with
   * the state the core owns.
   *
   * The state half is the only authoritative answer to how much authority is
   * left, because the running total and the live reservations are never supplied
   * by a client. A merchant key reads any of its own mandates; the agent the
   * mandate names reads that one through its own credential.
   */
  getMandate(id: string, opts: Pick<RequestOptions, 'signal'> = {}): Promise<Mandate> {
    return this.#http.request<Mandate>('GET', `${MANDATES}/${encodeId(id)}`, { signal: opts.signal });
  }

  /**
   * Revoke one of this merchant's agent mandates.
   *
   * Pass the principal's signed revocation where you have one — its authority is
   * the signature, not this credential, which is what lets a principal withdraw
   * through any relay. Without one this revokes on the merchant's own authority,
   * which is allowed for a mandate scoped to this merchant.
   *
   * Idempotent and one-way: `revoked_at` is set once and never cleared, and
   * revoking again returns the mandate unchanged. Effective on the very next
   * authorization, with no propagation window. It transitions no session — an
   * attempt already at the rail resolves on its own.
   */
  revokeMandate(id: string, revocation?: MandateRevocation, opts: RequestOptions = {}): Promise<Mandate> {
    return this.#mutate<Mandate>(`${MANDATES}/${encodeId(id)}/revoke`, revocation ?? {}, opts);
  }

  getSigningKeys(opts: Pick<RequestOptions, 'signal'> = {}): Promise<SigningKeys> {
    return this.#http.request<SigningKeys>('GET', '/v1/signing_keys', { signal: opts.signal });
  }

  #mutate<T>(path: string, body: unknown, opts: RequestOptions): Promise<T> {
    return this.#http.request<T>('POST', path, {
      body,
      attachIdempotencyKey: true,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
  }

  // Built per watch rather than held on the instance: it closes over nothing a
  // watch may outlive, and the credential is read from the transport per call.
  #watchSource(): SessionSource {
    return sessionSource(this.#http);
  }
}
