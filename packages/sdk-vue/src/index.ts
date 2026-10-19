// @flutterwavebnw/checkout-vue — Vue bindings for Flutterwave Checkout.
//
// A composable that drives one CheckoutSession over the browser (client_secret)
// client, plus the framework-agnostic store it wraps (re-exported from the SDK's
// browser entry, where it lives and where the React bindings share it). Session
// types and the error classes come from that same node-free entry, so nothing
// here pulls a Node-only dependency.

export { useCheckoutSession } from './useCheckoutSession.js';
export type { UseCheckoutSession, UseCheckoutSessionOptions } from './useCheckoutSession.js';

// The drop-in: an inline checkout on the merchant's own page, no redirect and no
// card data in their DOM. The composable above is the other integration shape —
// build your own interface over the session; this one renders ours inside your
// layout.
export { CheckoutDropIn } from './CheckoutDropIn.js';
export type { PublicSessionState, SessionCredentials } from '@flutterwavebnw/checkout-runtime';

// The card field: one framed input for a checkout you designed yourself. Pair it
// with the composable above — the composable drives the session, the field
// collects the card your page must never hold, and what passes between them is a
// token.
export { CardField } from './CardField.js';
export type { CardFieldExposed } from './CardField.js';
export type {
  CapturedCard,
  CardFieldAppearance,
  CardFieldErrorCode,
  CardFieldState,
} from '@flutterwavebnw/checkout-runtime';

export { CheckoutSessionStore } from '@flutterwavebnw/checkout-sdk/browser';
export type {
  CheckoutSessionStoreOptions,
  CheckoutState,
  CheckoutPhase,
} from '@flutterwavebnw/checkout-sdk/browser';

// Re-export the error classes + session types so a Vue consumer needs only this
// package.
export {
  CheckoutError,
  CheckoutConnectionError,
  isCoreError,
  isTerminal,
  isBuyerFinal,
  isWaitingOnRail,
} from '@flutterwavebnw/checkout-sdk/browser';
export type {
  BrowserSurface,
  WatchOptions,
  CheckoutSession,
  Money,
  EligibleMethod,
  PaymentMethod,
  PaymentMethodRef,
  NextAction,
  CollectionConfirmation,
  SessionStatus,
  CoreError,
  SelectMethodRequest,
  SetCustomerRequest,
  FxQuoteRequest,
  AuthorizeRequest,
  CompleteActionRequest,
  CancelRequest,
} from '@flutterwavebnw/checkout-sdk/browser';
