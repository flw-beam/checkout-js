// The agent channel: minting the credential an agent presents, signing the
// artefacts a mandate is exercised with, and the client an agent drives a
// session through.
//
// Two keys with different jobs, and keeping them apart is the whole security
// argument. A PRINCIPAL key signs the mandate terms and any revocation of them —
// it is the person authorizing spending. An AGENT key signs the attestation and
// every per-use presentation — it is the software exercising that authorization.
// A compromised agent key can therefore spend only what the principal already
// signed for, because minting wider terms needs a key the agent never holds.
//
// Nothing here decides anything. The caps, the allowlist, the expiry, the running
// total, the replay set: all of it is enforced by the core, server-side, before a
// session may enter authorizing. What this module produces is credentials; what
// they are worth is not its call. In particular, do not treat a locally-built
// mandate as authoritative about remaining headroom — read the mandate, where the
// state half is the core's own.
//
// Server-side only. It holds private keys and uses Node's crypto, exactly as the
// webhook verifier does; an agent key in a browser is an agent key published.
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { canonicalBytes } from './jcs.js';
import { MANDATES, SESSIONS, Transport, encodeId } from './http.js';
import { latestSnapshot, sessionSource, watchSnapshots } from './watch.js';
import type { WatchOptions } from './watch.js';
import type {
  AuthorizeRequest,
  CheckoutSession,
  CollectionConfirmation,
  CompleteActionRequest,
  CreateSessionRequest,
  EligibleMethod,
  EligibleMethodsResponse,
  FxQuoteRequest,
  Mandate,
  MandatePresentation,
  MandateRevocation,
  MandateTerms,
  SelectMethodRequest,
  SetCustomerRequest,
} from './types.js';
import type { RequestOptions } from './client.js';

/**
 * An Ed25519 private key, as a PKCS#8 PEM string or an already-imported KeyObject
 * accepted by Node's crypto. A raw 32-byte seed is not accepted: the ambiguity
 * between a seed, a scalar, and a DER encoding is exactly the kind of thing that
 * silently produces signatures nothing can verify.
 */
export type Ed25519PrivateKey = string | Parameters<typeof edSign>[2];

export interface AgentIdentityOptions {
  /** The human ultimately responsible, e.g. "prn_...". */
  principal: string;
  /** This agent, e.g. "act_...". Must match the identity registered with checkout. */
  agent: string;
  /** The merchant context being acted in, e.g. "mrc_...". Must own the sessions driven. */
  merchant: string;
  /** The `kid` of this agent's registered verification key, e.g. "agk_...". */
  kid: string;
  /** This agent's Ed25519 private key. Never the principal's. */
  privateKey: Ed25519PrivateKey;
  /** Clock override, for tests. */
  now?: () => Date;
}

/**
 * The agent's identity and signing key: what mints an attestation, and what signs
 * a per-use presentation.
 *
 * An attestation is minted per request rather than once per client, because its
 * freshness window is measured in a request's flight time — that window is its
 * whole replay exposure, since an attestation is deliberately not single-use.
 * Reusing one across a long-lived client would be holding a credential open for
 * exactly as long as the window exists to prevent.
 */
export class AgentIdentity {
  readonly #options: AgentIdentityOptions;
  readonly #key: ReturnType<typeof createPrivateKey> | Parameters<typeof edSign>[2];
  readonly #now: () => Date;

  constructor(options: AgentIdentityOptions) {
    for (const field of ['principal', 'agent', 'merchant', 'kid'] as const) {
      if (!options[field]) throw new Error(`AgentIdentity: ${field} is required`);
    }
    if (!options.privateKey) throw new Error('AgentIdentity: privateKey is required');
    this.#options = options;
    this.#key = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
    this.#now = options.now ?? (() => new Date());
  }

  get principal(): string {
    return this.#options.principal;
  }

  get agent(): string {
    return this.#options.agent;
  }

  get merchant(): string {
    return this.#options.merchant;
  }

  /**
   * A freshly-signed attestation, as the bearer value to present. Identity only:
   * it says which registered agent is calling, and confers no authority to spend.
   */
  attestation(): string {
    const claims = {
      principal: this.#options.principal,
      agent: this.#options.agent,
      merchant: this.#options.merchant,
      kid: this.#options.kid,
      issued_at: rfc3339(this.#now()),
    };
    const signed = { ...claims, signature: this.#sign(claims) };
    return `agt_${base64url(new TextEncoder().encode(JSON.stringify(signed)))}`;
  }

  /**
   * A per-use presentation for one authorization: the mandate, a one-time nonce,
   * and the moment of use, signed with this agent's key.
   *
   * Sign one per authorize. The core rejects a `(mandate_id, nonce)` it has seen,
   * which is what makes a captured authorization useless — including for a
   * recurring mandate, whose second legitimate use would look like a replay under
   * any single static nonce.
   */
  presentation(mandateId: string, nonce: string = randomNonce()): MandatePresentation {
    const claims = {
      mandate_id: mandateId,
      nonce,
      signed_at: rfc3339(this.#now()),
      kid: this.#options.kid,
    };
    return { ...claims, signature: this.#sign(claims) } as MandatePresentation;
  }

  #sign(claims: Record<string, unknown>): string {
    return base64url(edSign(null, canonicalBytes(claims), this.#key));
  }
}

export interface PrincipalKeyOptions {
  /** The principal, e.g. "prn_...". */
  principal: string;
  /** The `kid` of the principal's registered verification key, e.g. "agk_...". */
  kid: string;
  /** The principal's Ed25519 private key. This is the key that authorizes spending. */
  privateKey: Ed25519PrivateKey;
  /** Clock override, for tests. */
  now?: () => Date;
}

/**
 * The principal's key: what signs a mandate into existence, and what withdraws
 * it.
 *
 * Kept separate from AgentIdentity as a type, not just as a value, so a program
 * cannot accidentally hand an agent the key that authorizes it. In a real
 * deployment these two rarely live in the same process at all — the principal
 * signs in a wallet or a consent surface, the agent runs elsewhere with only its
 * own key.
 */
export class PrincipalKey {
  readonly #options: PrincipalKeyOptions;
  readonly #key: ReturnType<typeof createPrivateKey> | Parameters<typeof edSign>[2];
  readonly #now: () => Date;

  constructor(options: PrincipalKeyOptions) {
    if (!options.principal) throw new Error('PrincipalKey: principal is required');
    if (!options.kid) throw new Error('PrincipalKey: kid is required');
    if (!options.privateKey) throw new Error('PrincipalKey: privateKey is required');
    this.#options = options;
    this.#key = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Sign mandate terms.
   *
   * `principal` is filled from this key, so terms cannot be signed on somebody
   * else's behalf by mistake. Everything else is the caller's decision and the
   * core's to enforce — with two shapes worth knowing before you build one: an
   * empty `merchant_allowlist` means NO merchant is allowed (never all), and an
   * expiry beyond the core's clamp is refused rather than shortened.
   */
  signTerms(terms: Omit<MandateTerms, 'principal' | 'kid' | 'signature'>): MandateTerms {
    const claims = { ...terms, principal: this.#options.principal, kid: this.#options.kid };
    return { ...claims, signature: this.#sign(claims) } as MandateTerms;
  }

  /**
   * Sign a revocation. This is the one-tap withdrawal: the authority is the
   * signature, so it needs no checkout credential of its own — whoever relays it
   * cannot alter it, and cannot revoke without it.
   */
  signRevocation(mandateId: string, revokedAt: Date = this.#now()): MandateRevocation {
    const claims = { mandate_id: mandateId, revoked_at: rfc3339(revokedAt), kid: this.#options.kid };
    return { ...claims, signature: this.#sign(claims) } as MandateRevocation;
  }

  #sign(claims: Record<string, unknown>): string {
    return base64url(edSign(null, canonicalBytes(claims), this.#key));
  }
}

export interface CheckoutAgentClientOptions {
  /** The agent's identity and signing key. */
  identity: AgentIdentity;
  /** Base URL of the checkout API. */
  baseUrl: string;
  /** Injectable fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Idempotency-key generator for mutating calls. Default: a random UUID per call. */
  generateIdempotencyKey?: () => string;
}

/**
 * The client an agent drives a session through.
 *
 * It is the same headless API every other surface sits on — there is no agent
 * back channel and no agent-only field. What differs is the credential (a fresh
 * attestation per request) and one obligation: `authorize` under a mandate must
 * carry a per-use presentation, and this client will not send one without it.
 *
 * The verbs an agent does NOT get are as deliberate as the ones it does. There is
 * no merchant-wide session list or event feed here: an agent's authority is the
 * sessions it acts on under its mandate, and a merchant-wide read would turn a
 * narrow authority to spend into a broad authority to read every buyer's
 * activity. The core refuses those to an attestation, so exposing them would only
 * produce a confusing error.
 */
export class CheckoutAgentClient {
  readonly #http: Transport;
  readonly #identity: AgentIdentity;

  constructor(options: CheckoutAgentClientOptions) {
    if (!options.identity) throw new Error('CheckoutAgentClient: identity is required');
    this.#identity = options.identity;
    this.#http = new Transport({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      // Per request, not per client: an attestation's freshness window is its
      // whole replay exposure, so it is minted as late as possible.
      authHeaders: () => ({ Authorization: `Bearer ${options.identity.attestation()}` }),
      newIdempotencyKey: options.generateIdempotencyKey,
    });
  }

  get identity(): AgentIdentity {
    return this.#identity;
  }

  /**
   * Create a session, optionally under a mandate the principal signed.
   *
   * The mandate is registered by this call, and the terms are compared against
   * the registered copy on every later presentation of the same id — so a mandate
   * cannot be widened by re-presenting it with a bigger number. Without a
   * mandate, this is Mode 1: the agent assembles the session up to the money and a
   * human authorizes it.
   */
  createSession(body: CreateSessionRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(SESSIONS, body, opts);
  }

  /** Fetch a session, including its mandate's authoritative state. */
  getSession(id: string, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#http.request<CheckoutSession>('GET', `${SESSIONS}/${encodeId(id)}`, { signal: opts.signal });
  }

  /** The methods eligible for this session's current context, ranked. */
  async getEligibleMethods(id: string, opts: RequestOptions = {}): Promise<EligibleMethod[]> {
    const res = await this.#http.request<EligibleMethodsResponse>(
      'GET',
      `${SESSIONS}/${encodeId(id)}/methods`,
      { signal: opts.signal },
    );
    return res.data;
  }

  /**
   * Lock an FX quote and re-derive the disclosed total. Not available yet: the
   * checkout API does not implement fx_quote and answers 501, raised here as a
   * CheckoutConnectionError, so no currency conversion is offered.
   */
  quoteFx(id: string, body: FxQuoteRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/fx_quote`, body, opts);
  }

  /** Set or replace the buyer on a live session. */
  setCustomer(id: string, body: SetCustomerRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/set_customer`, body, opts);
  }

  /** Choose a payment method, which may re-derive the total with the rail's fee. */
  selectMethod(id: string, body: SelectMethodRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/select_method`, body, opts);
  }

  /**
   * Start collection under a mandate.
   *
   * A presentation is minted here unless the caller supplies one, so the ordinary
   * path cannot forget it. `expected_charge_amount` is the total the agent was
   * shown and is re-verified server-side: a mismatch is refused rather than
   * re-quoted, so re-read the session, re-disclose the new total, and try again.
   *
   * A mandate refusal — over cap, out of allowlist, expired, revoked, replayed —
   * arrives as a CheckoutError in the `mandate` category with `suggested_action:
   * step_up`. That is not a retry: the ceiling will not move on one. It means a
   * human has to approve this payment (Mode 1).
   */
  authorize(
    id: string,
    body: Omit<AuthorizeRequest, 'mandate_presentation'> & {
      mandate_presentation?: MandatePresentation;
      /** The mandate being exercised. Omit only for a Mode 1 session that carries none. */
      mandateId?: string;
    },
    opts: RequestOptions = {},
  ): Promise<CheckoutSession> {
    const { mandateId, ...rest } = body;
    const presentation =
      rest.mandate_presentation ?? (mandateId ? this.#identity.presentation(mandateId) : undefined);
    const payload: AuthorizeRequest = presentation
      ? ({ ...rest, mandate_presentation: presentation } as AuthorizeRequest)
      : (rest as AuthorizeRequest);
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/authorize`, payload, opts);
  }

  /** Submit the result of a pending next_action. */
  completeAction(id: string, body: CompleteActionRequest, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/complete_action`, body, opts);
  }

  /** Ask the rail for this attempt's status now, rather than waiting for reconciliation. */
  refresh(id: string, opts: Pick<RequestOptions, 'signal'> = {}): Promise<CheckoutSession> {
    return this.#http.request<CheckoutSession>('POST', `${SESSIONS}/${encodeId(id)}/refresh`, {
      signal: opts.signal,
    });
  }

  /** Cancel a session before collection. */
  cancel(id: string, body: { reason?: string } = {}, opts: RequestOptions = {}): Promise<CheckoutSession> {
    return this.#mutate<CheckoutSession>(`${SESSIONS}/${encodeId(id)}/cancel`, body, opts);
  }

  /**
   * Watch one session until the buyer has nothing left to do, so a caller holds a
   * connection instead of polling. A stop is never an outcome: a deadline hands
   * back the live session rather than raising, because reading a slow rail as a
   * failure cancels an order for a buyer who was charged.
   */
  watchSession(id: string, opts: WatchOptions = {}): AsyncGenerator<CheckoutSession, void, void> {
    return watchSnapshots(sessionSource(this.#http), id, opts);
  }

  /** The last state a watch would yield: the session once the buyer is finished. */
  waitForSession(id: string, opts: WatchOptions = {}): Promise<CheckoutSession> {
    return latestSnapshot(sessionSource(this.#http), id, opts);
  }

  /**
   * The collection confirmation. Distinct from a financial receipt: it says this
   * collection completed, not that funds have settled.
   */
  getConfirmation(id: string, opts: RequestOptions = {}): Promise<CollectionConfirmation> {
    return this.#http.request<CollectionConfirmation>('GET', `${SESSIONS}/${encodeId(id)}/confirmation`, {
      signal: opts.signal,
    });
  }

  /**
   * Read a mandate: the signed terms, and the state the core owns.
   *
   * This is the only authoritative answer to how much authority is left. A local
   * copy of the terms says what was granted; only this says what remains, because
   * the running total and the live reservations are the core's and are never
   * supplied by a client.
   */
  getMandate(id: string, opts: Pick<RequestOptions, 'signal'> = {}): Promise<Mandate> {
    return this.#http.request<Mandate>('GET', `${MANDATES}/${encodeId(id)}`, { signal: opts.signal });
  }

  /**
   * Revoke a mandate.
   *
   * With no signed revocation, this asks on the agent's own authority — which is
   * always allowed, because giving up your own authority only ever narrows it. An
   * agent that detects its own compromise should call this without waiting for a
   * human. Effective on the very next authorization, with no propagation window.
   */
  revokeMandate(id: string, revocation?: MandateRevocation, opts: RequestOptions = {}): Promise<Mandate> {
    return this.#mutate<Mandate>(`${MANDATES}/${encodeId(id)}/revoke`, revocation ?? {}, opts);
  }

  #mutate<T>(path: string, body: unknown, opts: RequestOptions): Promise<T> {
    return this.#http.request<T>('POST', path, {
      body,
      attachIdempotencyKey: true,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
  }
}

/**
 * A one-time nonce for a presentation. 128 bits from the platform CSPRNG: the
 * core rejects a nonce it has seen, so what this has to guarantee is that a
 * legitimate second authorization never collides with a legitimate first.
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Node's sign() hands back a Buffer and the canonicalizer a Uint8Array. Both are
// byte views, and the encoding is the same either way; the parameter is widened
// rather than the values converted, because a copy here would be a copy of a
// signature on every request for the benefit of one type declaration.
function base64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}
