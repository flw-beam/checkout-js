// The session mental model, sourced entirely from the generated contract
// bindings — never hand-declared. Every surface (hosted, SDK, MCP) renders and
// drives the one canonical CheckoutSession; there is no second session shape
// and no side-channel field. Request bodies are the same named schemas the API
// validates against, so the SDK and the core cannot drift.
import type { components } from '@flutterwavebnw/checkout-contracts/openapi';

type Schemas = components['schemas'];

// --- The resource and its parts ---------------------------------------------
export type CheckoutSession = Schemas['CheckoutSession'];
export type Money = Schemas['Money'];
export type LineItem = Schemas['LineItem'];
export type Fee = Schemas['Fee'];
export type Tax = Schemas['Tax'];
export type FxQuote = Schemas['FxQuote'];
export type Actor = Schemas['Actor'];
export type Customer = Schemas['Customer'];
export type EligibleMethod = Schemas['EligibleMethod'];
export type PaymentMethod = Schemas['PaymentMethod'];
export type PaymentMethodRef = Schemas['PaymentMethodRef'];
export type NextAction = Schemas['NextAction'];
export type StatusContext = Schemas['StatusContext'];
export type CollectionConfirmation = Schemas['CollectionConfirmation'];
export type SessionStatus = Schemas['SessionStatus'];
export type Surface = Schemas['Surface'];

// --- The agent channel -------------------------------------------------------
// The mandate as a session read returns it: the principal's signed terms with
// the state the core owns. A client supplies only the terms; the state half is
// authoritative and output-only, which is what makes a local copy of a running
// total worthless for deciding anything.
export type Mandate = Schemas['Mandate'];
export type MandateTerms = Schemas['MandateTerms'];
export type MandateState = Schemas['MandateState'];
export type MandatePresentation = Schemas['MandatePresentation'];
export type MandateRevocation = Schemas['MandateRevocation'];
export type AgentAttestation = Schemas['AgentAttestation'];
export type MandateNotice = Schemas['MandateNotice'];

/** The stable, versioned error shape returned on every endpoint. */
export type CoreError = Schemas['Error'];
export type ErrorCategory = Schemas['ErrorCategory'];
export type SuggestedAction = Schemas['SuggestedAction'];

// --- Events, handoffs & verification keys -----------------------------------
export type Event = Schemas['Event'];
export type EventType = Schemas['EventType'];
export type SigningKeys = Schemas['SigningKeys'];

// --- Request bodies (the same schemas the core validates) -------------------
export type CreateSessionRequest = Schemas['CreateSessionRequest'];
export type SelectMethodRequest = Schemas['PaymentMethodRef'];
export type SetCustomerRequest = Schemas['SetCustomerRequest'];
export type FxQuoteRequest = Schemas['FxQuoteRequest'];
export type AuthorizeRequest = Schemas['AuthorizeRequest'];
export type CompleteActionRequest = Schemas['CompleteActionRequest'];
export type CancelRequest = Schemas['CancelRequest'];

// --- Thin list/read envelopes -----------------------------------------------
export type EligibleMethodsResponse = Schemas['EligibleMethodsResponse'];
export type EventsResponse = Schemas['EventsResponse'];
export type EventFeedResponse = Schemas['EventFeedResponse'];
export type SessionListResponse = Schemas['SessionListResponse'];
export type RailHealth = Schemas['RailHealth'];
export type RailHealthResponse = Schemas['RailHealthResponse'];

// The five terminal states: a session in one of these can no longer be driven,
// and resuming means creating a new session.
const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'succeeded',
  'failed',
  'expired',
  'canceled',
  'abandoned',
]);

// The states where the buyer has nothing left to do. Every terminal state
// qualifies, plus `awaiting_confirmation`, where the buyer has paid and the rail
// is still answering on its own clock — which in some markets is days.
const BUYER_FINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  ...TERMINAL,
  'awaiting_confirmation',
]);

/**
 * Whether a session has reached a terminal state and can no longer change.
 *
 * Note that this is false for `awaiting_confirmation`: that session still
 * resolves to `succeeded` or `failed` later. To decide what to show a buyer —
 * whether to stop rendering a payment UI — use {@link isBuyerFinal} instead.
 */
export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Whether nothing further will be asked of the buyer: no action to complete, no
 * method to pick, nothing to submit. True for every terminal state and for
 * `awaiting_confirmation`.
 *
 * This is the check a checkout UI wants. Polling on `!isTerminal(status)` alone
 * leaves a buyer who has already paid staring at a live payment form for as long
 * as the rail takes to settle. Show them the outcome is coming — the session's
 * `expected_resolution_at` says when — and let them leave.
 */
export function isBuyerFinal(status: SessionStatus): boolean {
  return BUYER_FINAL.has(status);
}

// The states where money is in flight and only the rail can resolve it: a caller
// holds and watches, it never resubmits.
const IN_FLIGHT: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'authorizing',
  'processing',
  'pending',
]);

/**
 * Whether the session is waiting on a rail: money in flight, or an instruction
 * the buyer carries out somewhere the core cannot see — a transfer to send, a
 * wallet prompt to approve on a handset.
 *
 * This is the condition a watch is for, and the condition in which there is
 * nothing to submit. A caller that resubmits here risks a second collection; a
 * caller that reads a wait as a failure abandons a payment that may still land.
 * Hold, watch, and let the core report what the rail says.
 */
export function isWaitingOnRail(session: CheckoutSession): boolean {
  if (IN_FLIGHT.has(session.status)) return true;
  const action = session.next_action?.type;
  return action === 'display_transfer_details' || action === 'stk_push';
}
