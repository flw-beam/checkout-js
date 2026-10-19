// The browser entry for Checkout: everything a page may use to drive one session
// over its session-scoped `client_secret`, and nothing that needs a server.
//
// Two layers, for the two ways a page holds a session. CheckoutBrowserClient is
// the verbs themselves, one call per action. CheckoutSessionStore sits on top and
// holds the session as state that moves forward — the shape every UI framework
// binding wraps, so React, Vue, and a page with no framework at all drive a
// session the same way rather than each keeping its own copy of that logic.
//
// Nothing in this module graph imports from `node:*`, so it bundles cleanly for
// the browser. Never put a merchant API key in a browser; use CheckoutClient (the
// server entry) for that.
export { CheckoutBrowserClient } from './browser-client.js';
export type { BrowserSurface, CheckoutBrowserClientOptions, RequestOptions } from './browser-client.js';

export { CheckoutSessionStore } from './store.js';
export type { CheckoutSessionStoreOptions, CheckoutState, CheckoutPhase } from './store.js';

// The node-free public surface for the browser entry: the error classes to
// catch and the session mental model. Webhook verification and canonicalization
// are deliberately absent here — they are server-side (they use node:crypto) and
// live on the main entry.
export { CheckoutError, CheckoutConnectionError, isCoreError } from './errors.js';
export { isTerminal, isBuyerFinal, isWaitingOnRail } from './types.js';
export type { WatchOptions } from './watch.js';
export type {
  CheckoutSession,
  Money,
  LineItem,
  Fee,
  Tax,
  FxQuote,
  Actor,
  Customer,
  EligibleMethod,
  PaymentMethod,
  PaymentMethodRef,
  NextAction,
  StatusContext,
  CollectionConfirmation,
  SessionStatus,
  Surface,
  CoreError,
  ErrorCategory,
  SuggestedAction,
  SelectMethodRequest,
  SetCustomerRequest,
  FxQuoteRequest,
  AuthorizeRequest,
  CompleteActionRequest,
  CancelRequest,
} from './types.js';
