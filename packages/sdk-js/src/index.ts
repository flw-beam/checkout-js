// @flutterwavebnw/checkout-sdk — the TypeScript-first server SDK for Flutterwave Checkout.
//
// A thin, typed client over the one headless collection API, plus a verifier
// for the core's Ed25519 provenance signature on events. The types are the
// canonical contract types (generated from /contracts) — the SDK adds no
// session shape of its own and no back channel.

// Clients
export { CheckoutClient } from './client.js';
export type { CheckoutClientOptions, RequestOptions } from './client.js';
// The browser (client_secret) client is also re-exported here for discovery; a
// browser bundle should import it from '@flutterwavebnw/checkout-sdk/browser', which is
// node-free (this entry additionally pulls in the server-only webhook verifier).
export { CheckoutBrowserClient } from './browser-client.js';
export type { CheckoutBrowserClientOptions } from './browser-client.js';

// The agent channel (Mode 2: an agent spending under a principal's mandate).
// Server-side only — it holds private keys.
export { AgentIdentity, PrincipalKey, CheckoutAgentClient, randomNonce } from './agent.js';
export type {
  AgentIdentityOptions,
  PrincipalKeyOptions,
  CheckoutAgentClientOptions,
  Ed25519PrivateKey,
} from './agent.js';

// Watching one session (the alternative to a polling loop)
export type { WatchOptions } from './watch.js';

// Errors
export { CheckoutError, CheckoutConnectionError, isCoreError } from './errors.js';

// Webhook / event provenance verification
export { Webhooks, WebhookVerificationError, verifySignature } from './webhooks.js';
export type { WebhooksOptions } from './webhooks.js';

// Canonicalization (exposed for advanced/interop use — same scheme the core signs with)
export { canonicalize, canonicalBytes } from './jcs.js';

// The session mental model
export { isTerminal, isBuyerFinal, isWaitingOnRail } from './types.js';
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
  Event,
  EventType,
  MandateNotice,
  Mandate,
  MandateTerms,
  MandateState,
  MandatePresentation,
  MandateRevocation,
  AgentAttestation,
  SigningKeys,
  CreateSessionRequest,
  SelectMethodRequest,
  SetCustomerRequest,
  FxQuoteRequest,
  AuthorizeRequest,
  CompleteActionRequest,
  CancelRequest,
  EligibleMethodsResponse,
  EventsResponse,
} from './types.js';
