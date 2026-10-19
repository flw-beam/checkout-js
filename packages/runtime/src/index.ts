// @flutterwavebnw/checkout-runtime — the browser runtime for a Flutterwave Checkout that
// renders on your own page, driving the same CheckoutSession over its
// client_secret.
//
// It loads one script and gives you a typed handle on it, and that script offers
// two integration shapes. The **drop-in** (`mount`) renders our checkout inside
// an element of yours: no redirect, nothing to design. The **card field**
// (`mountCardField`) goes the other way — you build the whole checkout and mount
// one input of ours where the card goes, so your page never holds a card number
// and never joins the cardholder data environment.
//
// This package contains no payment logic, no protocol, and no credential
// handling of its own — that all lives in the script it fetches, served from the
// same deployment as the checkout it frames, so it is corrected for every
// integration at once rather than whenever each merchant reinstalls.
//
// Importing this module fetches nothing. The script tag is added by the first
// call to `loadCheckout`, so a page that never reaches a checkout never pays for
// one — and calling it early to warm the connection is just as valid, since the
// result is cached per origin.

export { loadCheckout } from './loader.js';
export type {
  CapturedCard,
  CardField,
  CardFieldAppearance,
  CardFieldErrorCode,
  CardFieldState,
  DropIn,
  FlutterwavebnwCheckout,
  LoadOptions,
  MountCardFieldOptions,
  MountOptions,
  MountWithFetch,
  MountWithSession,
  PublicSessionState,
  SessionCredentials,
  StepUpHandle,
} from './types.js';
