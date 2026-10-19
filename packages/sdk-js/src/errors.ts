// Errors are a product surface: a person reads `messageHuman`, an agent reads
// `code`/`suggestedAction`, and every error carries a forward path — no dead
// ends. The SDK preserves the checkout API's stable Error shape verbatim and adds
// the HTTP status and any Retry-After hint the transport carried.
import type { CoreError, ErrorCategory, SessionStatus, SuggestedAction } from './types.js';

/**
 * A structured error the checkout API returned as its stable Error shape.
 * Callers branch on `code`/`category`/`suggestedAction`; `retriable` and
 * `retryAfter` say whether and when a retry (with a fresh idempotency key on a
 * mutating call) may succeed.
 */
export class CheckoutError extends Error {
  readonly name = 'CheckoutError';
  /** Stable, machine-readable, versioned error code, e.g. "rail_timeout". */
  readonly code: string;
  readonly category: ErrorCategory;
  readonly messageHuman: string;
  readonly messageMachine: string;
  readonly suggestedAction: SuggestedAction;
  readonly retriable: boolean;
  /** Where the session landed after the error, or null if raised before one existed. */
  readonly sessionStatus: SessionStatus | null;
  readonly requestId: string;
  /** The HTTP status the checkout API responded with. */
  readonly status: number;
  /** Seconds to wait before retrying, when the response carried Retry-After. */
  readonly retryAfter?: number;
  /** The full, unmodified stable Error shape. */
  readonly error: CoreError;

  constructor(status: number, error: CoreError, retryAfter?: number) {
    super(error.message_human || error.code);
    this.status = status;
    this.error = error;
    this.code = error.code;
    this.category = error.category;
    this.messageHuman = error.message_human;
    this.messageMachine = error.message_machine;
    this.suggestedAction = error.suggested_action;
    this.retriable = error.retriable;
    this.sessionStatus = error.session_status ?? null;
    this.requestId = error.request_id;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/**
 * A transport-level failure: the request never reached the checkout API, timed
 * out, was aborted, or the API returned a response that was not the stable Error
 * shape (e.g. an infrastructure 502). Distinct from CheckoutError so callers can
 * tell "the checkout API declined" from "the checkout API was unreachable".
 */
export class CheckoutConnectionError extends Error {
  readonly name = 'CheckoutConnectionError';
  /** The HTTP status, when a response was received but was not a usable Error. */
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    if (options?.status !== undefined) this.status = options.status;
  }
}

/** True when a parsed body has the shape of the checkout API's stable Error. */
export function isCoreError(value: unknown): value is CoreError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === 'string' &&
    typeof v.category === 'string' &&
    typeof v.message_human === 'string' &&
    typeof v.message_machine === 'string' &&
    typeof v.suggested_action === 'string' &&
    typeof v.retriable === 'boolean' &&
    typeof v.request_id === 'string'
  );
}
