/**
 * The shape of the runtime this package loads.
 *
 * These are declarations only — there is no implementation of any of it here,
 * and that is the point of the package. What actually runs is served from the
 * checkout origin as `/v1/checkout.js`, so a correction to the code that handles
 * a payment credential reaches every integration on our next deploy rather than
 * on each merchant's. A copy of that logic bundled into a merchant's application
 * would be frozen at whatever version they last installed, and for the long tail
 * of integrations that is forever.
 *
 * So what this package contributes is the two things a served script cannot: a
 * typed surface a compiler can check, and a promise to await instead of a global
 * that may not have appeared yet. Both are build-time concerns, which is exactly
 * why they are the ones that belong at build time.
 *
 * These types are kept in step with the runtime by hand. They can only describe
 * it, never constrain it — a type that has drifted is wrong about a script it
 * does not ship. That is the trade this split makes deliberately: the runtime is
 * always current and the types may lag, rather than both being frozen together
 * on a merchant's disk. Nothing here is load-bearing at run time, so a stale
 * type is a compile error to fix, never a payment that behaves unexpectedly.
 */

/** A session your server created, as the drop-in needs it. */
export interface SessionCredentials {
  sessionId: string;
  /** That session's `client_secret`. */
  clientSecret: string;
}

interface MountCommon {
  /** Where the checkout goes: an element, or a CSS selector for one. */
  container: Element | string;
  /**
   * Called on every status change, and once on the first state the frame reads.
   *
   * A UI signal. Show a spinner, swap the panel, move the buyer along — but
   * fulfil the order from the `payment.succeeded` event delivered to your
   * server, which is the signed, durable record of the payment. Anyone who can
   * open a browser can post a message claiming success.
   */
  onSession?: (session: PublicSessionState) => void;
  /**
   * Called when the frame sends the buyer to their bank's authentication page in
   * a popup, and again is not proof of anything — it exists so the page can
   * explain a window the buyer did not ask for. `blocked` means the browser
   * refused the popup and the whole tab is navigating instead.
   */
  onStepUp?: (info: { blocked: boolean }) => void;
  /**
   * The frame did not answer within `readyTimeoutMs`. Usually a blocked frame or
   * a content policy on your page that forbids framing checkout.
   */
  onTimeout?: () => void;
  /**
   * `fetchSession` rejected, or resolved with something that is not a session.
   * No frame was created, so the container is empty: show the buyer something.
   */
  onError?: (error: Error) => void;
  /**
   * The frame can no longer show this session, so it is telling the buyer that
   * this checkout has closed. A session that ended while the buyer was away
   * does not come here: its `client_secret` still reads it until 30 minutes
   * past its expiry time, so the frame shows the buyer how it ended and reports
   * that through `onSession`. What is left is a session past that window, or
   * one past its expiry time that has not reached an ending yet, so this says
   * nothing about whether the buyer paid.
   *
   * Ask your server: it reads the session with your API key and sees how it
   * really ended. A session that succeeded, is awaiting confirmation, or is
   * still processing is a buyer to show their order to. Only one that failed,
   * expired, was canceled or was abandoned is a buyer to mount a new checkout
   * for. Called once per mount.
   */
  onClosed?: (info: { sessionId: string }) => void;
  /**
   * How long to wait for the frame before giving up, counted from when the
   * session is known. Default 20s.
   */
  readyTimeoutMs?: number;
  /** Accessible name for the frame. Defaults to "Checkout". */
  title?: string;
}

/** Mount a session your page already holds. */
export interface MountWithSession extends MountCommon {
  /** The session to drive, created by your server with your API key. */
  sessionId: string;
  /**
   * That session's `client_secret`, as returned to the server that created it.
   * It authorizes this one session and nothing else, and is handed to the frame
   * over a message rather than through the URL.
   */
  clientSecret: string;
  fetchSession?: never;
  reuseKey?: never;
}

/** Mount a session the runtime asks your server for. */
export interface MountWithFetch extends MountCommon {
  /**
   * Ask your server for the session: call an endpoint that creates it with your
   * API key and returns its id and `client_secret`, and resolve with those two.
   * Called once, when the drop-in needs a session and has none to reuse. `mount`
   * returns straight away and the frame appears once this resolves, so your page
   * has nothing to sequence.
   */
  fetchSession: () => Promise<SessionCredentials>;
  /**
   * What this checkout is paying for — an order id, or a cart id that changes
   * when the cart does. A later mount with the same key in the same tab reopens
   * the session already fetched for it instead of asking for another, until that
   * session ends. Without it, every mount fetches.
   *
   * Two mounts with the same key are the same purchase, so a key that stays the
   * same while the cart changes reopens a session for the old total.
   */
  reuseKey?: string;
  sessionId?: never;
  clientSecret?: never;
}

export type MountOptions = MountWithSession | MountWithFetch;

/** What your page learns about the session. Public state only. */
export interface PublicSessionState {
  sessionId: string;
  status: string;
  livemode: boolean;
  /** The buyer has nothing left to do — terminal, or a slow rail still settling. */
  buyerFinal: boolean;
}

export interface DropIn {
  /** Remove the frame and stop listening. Safe to call more than once. */
  destroy(): void;
  /**
   * The frame element, for styling. Its `src` and messaging are not yours to
   * drive. With `fetchSession` it joins the container once the session arrives.
   */
  readonly frame: HTMLIFrameElement;
}

/**
 * The styling you may give the card field. Values only — never CSS, a class
 * name, or a URL: what crosses into the field is data, which is what keeps it a
 * document your page cannot read into. Anything unrecognized is ignored and
 * named in the browser console rather than applied.
 */
export interface CardFieldAppearance {
  /** A font stack. A font this page loaded is not available inside the field. */
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  color?: string;
  placeholderColor?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: string;
  borderRadius?: string;
  padding?: string;
  height?: string;
  rowGap?: string;
  focusBorderColor?: string;
  errorBorderColor?: string;
}

/** Why the entry cannot be captured yet. A code, so the words stay yours. */
export type CardFieldErrorCode =
  | 'incomplete_number'
  | 'incomplete_expiry'
  | 'expired_card'
  | 'incomplete_cvc';

/** What you learn about the buyer's entry. Never its contents. */
export interface CardFieldState {
  /** Nothing has been typed yet. */
  empty: boolean;
  /** There is enough to attempt a capture. */
  complete: boolean;
  /** Why not, once the buyer has finished a field and moved on. */
  error: CardFieldErrorCode | null;
}

/** What a completed capture yields, and all it yields. */
export interface CapturedCard {
  /** The vault's single-use, short-lived instrument token. */
  token: string;
  /** A masked descriptor safe to show the buyer. */
  display: string;
  /** The last four digits, for a descriptor of your own. */
  last4: string;
  /** The card's six-digit IIN — the issuing bank, never the account. */
  issuer: string;
  /** When the token dies, as the vault reported it. Null when it did not say. */
  expiresAt: number | null;
}

export interface MountCardFieldOptions {
  /** The session this card will be captured for, created by your server. */
  sessionId: string;
  /**
   * That session's `client_secret`. The field reads the session with it to find
   * the vault; it is handed over in a message, never through the URL.
   */
  clientSecret: string;
  /** Where the field goes: an element, or a CSS selector for one. */
  container: Element | string;
  /** Bind the field to your own design tokens. */
  appearance?: CardFieldAppearance;
  /** Locale for the field's placeholders and accessible labels. */
  locale?: string;
  /** Called on every change to the entry's state. */
  onChange?: (state: CardFieldState) => void;
  /** The field is mounted and ready to accept a card. */
  onReady?: () => void;
  /**
   * A card cannot be collected here at all — the credential did not read the
   * session, or card is not available on it, which includes checkout's vault
   * being unavailable. Offer another method: the alternative is a buyer typing a
   * card into an input that was never going to submit it.
   */
  onUnavailable?: (info: { code: string; message: string }) => void;
  /** The field never answered — usually a framing policy on your page. */
  onTimeout?: () => void;
  /** How long to wait for the field before giving up. Default 20s. */
  readyTimeoutMs?: number;
  /** Accessible name for the frame. Defaults to "Card details". */
  title?: string;
}

export interface CardField {
  /**
   * Tokenize what the buyer typed. Resolves with the vault's token, which you
   * then pass to the checkout API yourself: `select_method` with
   * `{ method: 'card', token, display, issuer }`.
   *
   * Rejects with an error carrying a `code` when the entry is incomplete, when
   * the vault refuses it, or when the field is gone.
   */
  capture(): Promise<CapturedCard>;
  /** Restyle a mounted field. */
  setAppearance(appearance: CardFieldAppearance): void;
  /** Put the cursor in the field — for restoring focus after an error. */
  focus(): void;
  /** Empty the field, after a decline the buyer should retype through. */
  clear(): void;
  /** Remove the field and stop listening. Safe to call more than once. */
  destroy(): void;
  /** The frame element, for layout. Its `src` and messaging are not yours to drive. */
  readonly frame: HTMLIFrameElement;
}

/** The window a step-up was presented in. */
export interface StepUpHandle {
  /** The browser refused a window and the buyer's own tab is navigating instead. */
  blocked: boolean;
  /** Close the window once the session has left `requires_action`. */
  close(): void;
}

/** The loaded checkout runtime. */
export interface FlutterwavebnwCheckout {
  /** Put a checkout frame in an element on your page. */
  mount(options: MountOptions): DropIn;
  /**
   * Put a card entry in an element on your page, for a checkout you are building
   * yourself. The card is typed inside a frame on the checkout origin and posted
   * straight to the vault, so it never enters your page — what you get back is a
   * token.
   */
  mountCardField(options: MountCardFieldOptions): CardField;
  /**
   * Present a `requires_action` step-up without losing your page: a window, or
   * this tab if the browser refuses one. Call it straight from the buyer's press
   * — a window opened out of a timer or a promise callback is refused.
   *
   * Do not frame the URL yourself. It resolves to whatever container the rail
   * asked for, and a bank page that refuses to be framed refuses inside your
   * layout too, which shows the buyer a blank rectangle rather than an error.
   */
  presentStepUp(url: string): StepUpHandle;
  /**
   * The wire version the runtime speaks, readable for support and diagnostics.
   * It is not a negotiation: the frame the script opens is served by the same
   * deployment that served the script, so the two halves cannot disagree.
   */
  protocolVersion: number;
}

declare global {
  interface Window {
    /**
     * The runtime, once the script has run. Declared because the loader reads it
     * and because a merchant who added the `<script>` tag by hand uses it
     * directly — for them this global *is* the API, and it should be typed for
     * them too rather than reached for through a cast.
     */
    FlutterwavebnwCheckout?: FlutterwavebnwCheckout;
  }
}

export interface LoadOptions {
  /**
   * The checkout origin to load the runtime from, and therefore the origin the
   * drop-in will frame and post the credential to. Required, with no default:
   * it names the environment you integrate against, and a default would choose
   * one for you without saying so.
   *
   * This is the only place the address is configurable, and deliberately so. The
   * script decides where a live credential gets posted, so that decision has to
   * belong to whoever chose to load the script — after which the runtime derives
   * everything else from where it was served, and no per-mount option can point
   * one drop-in at a different checkout than the code driving it.
   */
  origin: string;
}
