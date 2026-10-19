// The session-driving state, kept framework-agnostic so it is testable without a
// DOM: a small store over the browser (client_secret) client that holds the
// current session and exposes the verbs a browser may drive. Every UI framework
// binding is a thin wrapper over this — React's hook over useSyncExternalStore,
// Vue's composable over a shallowRef — so a buyer's session behaves the same
// whichever framework the merchant chose. It carries no payment logic: every
// action is a call to the core, and the returned session is authoritative.
import { CheckoutBrowserClient } from './browser-client.js';
import type { BrowserSurface } from './browser-client.js';
import type {
  AuthorizeRequest,
  CancelRequest,
  CheckoutSession,
  CompleteActionRequest,
  EligibleMethod,
  FxQuoteRequest,
  SelectMethodRequest,
  SetCustomerRequest,
} from './types.js';

export type CheckoutPhase = 'loading' | 'ready' | 'error';

export interface CheckoutState {
  /** `loading` until the first fetch resolves, then `ready`, or `error` if it failed. */
  phase: CheckoutPhase;
  /** The current session snapshot the core computed, or null before the first load. */
  session: CheckoutSession | null;
  /** The ranked eligible methods, once loaded (null until then). */
  methods: EligibleMethod[] | null;
  /** True while a mutating action (or a load) is in flight. */
  busy: boolean;
  /** The last error, if any. Cleared when the next action starts. */
  error: unknown;
  /**
   * True while a live watch is holding this session's state — the session updates
   * itself, and nothing needs to be re-read by hand.
   */
  watching: boolean;
}

export interface CheckoutSessionStoreOptions {
  /** The session to drive. */
  sessionId: string;
  /** The session-scoped browser credential. */
  clientSecret: string;
  /** Base URL: the checkout API, or a same-origin proxy that forwards to it. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global fetch). */
  fetch?: typeof fetch;
  /**
   * Which skin is driving, recorded per action on the session's timeline.
   * Defaults to `inline` — an interface you built over the session, which is
   * what this store is. Set it only when you are driving a checkout of ours.
   */
  surface?: BrowserSurface;
  /**
   * Idempotency-key generator. Defaults to Web Crypto's randomUUID; supply one
   * on a runtime without it (e.g. some React Native engines).
   */
  generateIdempotencyKey?: () => string;
}

type Listener = () => void;

const INITIAL: CheckoutState = {
  phase: 'loading',
  session: null,
  methods: null,
  busy: false,
  error: null,
  watching: false,
};

export class CheckoutSessionStore {
  readonly #client: CheckoutBrowserClient;
  readonly #sessionId: string;
  readonly #listeners = new Set<Listener>();
  #state: CheckoutState = INITIAL;
  #watch: AbortController | null = null;

  constructor(options: CheckoutSessionStoreOptions) {
    this.#sessionId = options.sessionId;
    this.#client = new CheckoutBrowserClient({
      clientSecret: options.clientSecret,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      surface: options.surface,
      generateIdempotencyKey: options.generateIdempotencyKey,
    });
  }

  // Arrow fields so their identity is stable per instance: a binding may hand them
  // to its framework directly, and React's useSyncExternalStore requires stable
  // subscribe/getSnapshot references.
  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CheckoutState => this.#state;

  #set(patch: Partial<CheckoutState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l();
  }

  /** Fetch (or refresh) the session. Drives the initial `loading` -> `ready`/`error`. */
  load = async (): Promise<CheckoutSession> => {
    this.#set({ busy: true, error: null });
    try {
      const session = await this.#client.getSession(this.#sessionId);
      this.#applySession(session);
      this.#set({ phase: 'ready', busy: false });
      return session;
    } catch (error) {
      this.#set({ phase: 'error', busy: false, error });
      throw error;
    }
  };

  /**
   * Hold a live watch on the session, applying each state the core computes until
   * the buyer has nothing left to do. Returns the function that stops it.
   *
   * This is what a checkout should do while a rail is answering, and it is why
   * nothing here needs a polling loop: the SDK holds the core's session stream
   * with a slow re-read beneath it, so a transfer that confirms or a wallet prompt
   * the buyer approves lands in this store within a second of the core knowing,
   * and still lands if the connection was refused or died.
   *
   * Calling it while a watch is already running is a no-op that returns the
   * running watch's stop function, so a re-render cannot open a second one. A
   * stopped watch is not a running one, which is what makes a mount-unmount-mount
   * (React's strict mode performs one; a Vue KeepAlive or HMR can) end up watching
   * rather than idle.
   *
   * A watch that cannot continue is not a failed payment. The last state applied
   * stands, the error is surfaced for a caller that wants to show a hint, and the
   * merchant's server still hears the outcome on the webhook regardless of what
   * any browser saw.
   */
  watch = (): (() => void) => {
    // Aborted rather than merely present: the loop clears this field in its own
    // `finally`, which lands a turn later, so a re-watch immediately after a stop
    // would otherwise be answered with the dead watch's stop function and never
    // start.
    const running = this.#watch;
    if (running && !running.signal.aborted) return () => running.abort();

    const controller = new AbortController();
    this.#watch = controller;
    this.#set({ watching: true });

    void (async () => {
      try {
        for await (const session of this.#client.watchSession(this.#sessionId, {
          signal: controller.signal,
        })) {
          // A snapshot is the same session a read returns, so it is applied as one.
          this.#applySession(session);
        }
      } catch (error) {
        this.#set({ error });
      } finally {
        if (this.#watch === controller) {
          this.#watch = null;
          this.#set({ watching: false });
        }
      }
    })();

    return () => controller.abort();
  };

  /** Fetch the ranked eligible methods (freshly computed, not the session snapshot). */
  refreshMethods = async (): Promise<EligibleMethod[]> => {
    const methods = await this.#run(() => this.#client.getEligibleMethods(this.#sessionId));
    this.#set({ methods });
    return methods;
  };

  quoteFx = (body: FxQuoteRequest): Promise<CheckoutSession> =>
    this.#drive(() => this.#client.quoteFx(this.#sessionId, body));

  selectMethod = (body: SelectMethodRequest): Promise<CheckoutSession> =>
    this.#drive(() => this.#client.selectMethod(this.#sessionId, body));

  setCustomer = (body: SetCustomerRequest): Promise<CheckoutSession> =>
    this.#drive(() => this.#client.setCustomer(this.#sessionId, body));

  authorize = (body: AuthorizeRequest): Promise<CheckoutSession> =>
    this.#drive(() => this.#client.authorize(this.#sessionId, body));

  completeAction = (body: CompleteActionRequest): Promise<CheckoutSession> =>
    this.#drive(() => this.#client.completeAction(this.#sessionId, body));

  cancel = (body: CancelRequest = {}): Promise<CheckoutSession> =>
    this.#drive(() => this.#client.cancel(this.#sessionId, body));

  // Run a session-returning action: toggle busy, store the authoritative session
  // it returns, surface any error in state, and rethrow so the caller can react.
  async #drive(call: () => Promise<CheckoutSession>): Promise<CheckoutSession> {
    const session = await this.#run(call);
    this.#applySession(session);
    return session;
  }

  // The session in state only ever moves forward. Every path that sets it — a
  // read, an action's response, a watch snapshot — goes through here, because
  // they race: a snapshot already in flight when an action returns must not put
  // the older state back on screen. Versions increase on every persisted
  // transition, so comparing them is the whole check.
  #applySession(next: CheckoutSession): void {
    const held = this.#state.session;
    if (held && next.version <= held.version) return;
    this.#set({ session: next });
  }

  async #run<T>(call: () => Promise<T>): Promise<T> {
    this.#set({ busy: true, error: null });
    try {
      const result = await call();
      this.#set({ busy: false });
      return result;
    } catch (error) {
      this.#set({ busy: false, error });
      throw error;
    }
  }
}
