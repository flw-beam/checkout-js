# Changelog

Every package in this repository is released together, at one version. Each
entry describes what changed for someone integrating Flutterwave Checkout.

## 0.1.0

The first public release.

- `@flutterwavebnw/checkout-sdk`: a typed server client over the checkout API,
  authenticated with your secret key, with an idempotency key on every call that
  changes anything. A browser client for a session's `client_secret`, limited to
  the calls a buyer's browser may make. `watchSession` and `waitForSession`,
  which follow a session while a bank transfer or mobile money payment settles.
  `Webhooks.verify`, which checks that an event was signed by checkout.
- `@flutterwavebnw/checkout-runtime`: `loadCheckout`, which loads the drop-in
  checkout and the inline card field from the checkout origin you pass. Card
  details go from the buyer's browser to the vault and never touch your page.
- `@flutterwavebnw/checkout-react` and `@flutterwavebnw/checkout-vue`:
  `CheckoutDropIn`, `CardField`, and `useCheckoutSession`, a hook (React) or
  composable (Vue) that drives one session.
- `@flutterwavebnw/checkout-cli`: `flutterwavebnw-checkout listen`, which forwards
  test-mode events to a handler on your own machine.
- `@flutterwavebnw/checkout-contracts`: the API's types, generated from its
  contract. The SDK depends on it; you do not need to install it yourself.
