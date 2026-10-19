# @flutterwavebnw/checkout-contracts

The Flutterwave Checkout API's types, generated from its contract: every
request, response, session, money amount, error and event, exactly as the API
serves them.

You rarely install this yourself. `@flutterwavebnw/checkout-sdk` depends on it
and re-exports the types an integration uses (`CheckoutSession`, `Money`,
`Event`, the request bodies), and installing the SDK brings it from the same
release.

The files under `src/gen` are generated. A change to them is made to the
contract they come from, never by hand.
