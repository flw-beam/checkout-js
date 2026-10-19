# @flutterwavebnw/checkout-runtime

The Flutterwave Checkout browser runtime, in two shapes. The **drop-in** renders
our checkout inside an element of yours; the **card field** renders one input of
ours inside a checkout of yours. Either way: no redirect, no card data in your
DOM, driving the same `CheckoutSession` as every other surface over that
session's `client_secret`.

```bash
npm install https://github.com/flw-beam/checkout-js/releases/download/v0.1.0/flutterwavebnw-checkout-runtime-0.1.0.tgz
```

Releases are published on the [checkout-js repository](https://github.com/flw-beam/checkout-js/releases),
one tarball per package, rather than to a registry; pnpm, yarn and bun install the
same URL.

```js
import { loadCheckout } from '@flutterwavebnw/checkout-runtime';

const checkout = await loadCheckout({ origin: 'https://pay-checkout-staging.flw-neo.com' });
const dropIn = checkout.mount({
  sessionId,          // created by your server, with your API key
  clientSecret,       // that session's client_secret
  container: '#checkout',
  onSession(session) {
    if (session.status === 'succeeded') showThankYou();
  },
});

dropIn.destroy();     // when your page navigates away
```

No bundler? The same runtime is a script tag, and that is a first-class
integration rather than a fallback:

```html
<script src="https://pay-checkout-staging.flw-neo.com/v1/checkout.js"></script>
<script>
  var dropIn = FlutterwavebnwCheckout.mount({ sessionId, clientSecret, container: '#checkout' });
</script>
```

Building the checkout yourself? Mount the card field instead and keep the rest —
the layout, the method list, the button, the copy. Your page never holds a card
number; `capture()` hands it back a vault token to select the method with.

```js
const field = checkout.mountCardField({
  sessionId,
  clientSecret,
  container: '#card',
  appearance: { fontFamily: 'Inter, sans-serif', borderRadius: '8px' },
  onChange({ complete }) { setCanPay(complete); },
});

const { token, display, issuer } = await field.capture();
```

Rather not sequence the fetch yourself? Hand the drop-in a `fetchSession` that
asks your server, and name the purchase with a `reuseKey`. `mount` returns at
once, the frame appears when the session does, and a buyer who closes and reopens
the checkout for the same key in the same tab lands back on the session they
started instead of a new one:

```js
const dropIn = checkout.mount({
  container: '#checkout',
  reuseKey: orderId,
  fetchSession: () => fetch(`/api/orders/${orderId}/checkout`, { method: 'POST' }).then((r) => r.json()),
  onError: showProblem,
});
```

React and Vue consumers get both as components: `CheckoutDropIn` and `CardField`
in `@flutterwavebnw/checkout-react` and `@flutterwavebnw/checkout-vue`.

## What this package is

**A loader and a set of types. No payment code.**

What actually runs on your page is `/v1/checkout.js`, served from the checkout
origin — the same deployment that serves the checkout document it frames. This
package adds the script tag, waits for it, and hands you the runtime it defines.
`loadCheckout` is cached per origin, so calling it from ten components costs one
script tag.

That split is the point, and it is worth being explicit about why, because it
means an `npm update` here will never change how a payment behaves.

**The half that holds your credential is served, not shipped.** The code that
decides where a live `client_secret` gets posted has to be correctable. Bundled
into your application it would be frozen at whatever version you last installed,
and a fix would reach buyers only as fast as every merchant redeploys — which,
across a long tail of integrations, is never. Served from the checkout origin, a
fix is live everywhere on our next deploy. You are not expected to do anything.

**It also removes protocol skew.** The drop-in is two halves talking over
`postMessage`: one on your page, one in the frame. When both are published
together, one deploy moves both and they cannot disagree. When the page half
ships through a package manager, the version on your page is whatever you
installed and the version in the frame is whatever is live — and a mismatch does
not fail loudly, it renders a blank box forever, because the frame waits for a
message that never arrives under the name it is listening for.

**What is left here is what is safe to freeze.** Types a compiler can check, and
a promise to await instead of a global that may not have appeared yet. Both are
build-time concerns, which is exactly why they belong at build time.

The types are kept in step with the runtime by hand. They describe it; they
cannot constrain it. A stale type is a compile error to go fix, never a payment
that behaves in a way you did not expect.

## The three decisions worth knowing

**It is a frame, and that is the point.** The buyer's card is typed into a
document on checkout's own origin and posted straight to the vault from there.
Your page never holds an instrument field, never runs a script beside one, and
never joins the cardholder data environment. It also means the vault has one
origin to answer rather than every merchant origin that will ever exist, which is
not a list anyone can write in advance.

**The credential travels in a message, never in the frame's URL.** A URL is read
by anything that can see the iframe element, kept in browser history, and sent on
in a `Referer` header. The frame announces itself, your page replies with the
`client_secret` addressed to checkout's origin, and nothing after that is
broadcast. The credential only ever travels inward — there is no path that sends
it back out, and a test asserts it never reaches the wire.

**`onSession` is a UI signal, not proof of payment.** It comes from a browser,
and a browser can be made to say anything. Fulfil orders from the signed
`payment.succeeded` event delivered to your server; this callback is for moving
an interface along.

## Authentication step-ups

A rail that wants the buyer authenticated gets a window of its own, opened by the
frame from the buyer's own press. Rendering it inline is the tempting shape and
the broken one: a bank page that refuses to be framed refuses two levels down
just as hard as one, and the buyer gets a blank rectangle instead of an error.

If the browser refuses the window, the frame navigates the tab instead and the
buyer returns via the session's `return_destination`. That is a real degradation
of "no redirect", and it is why a merchant using the drop-in should set one.

## Choosing the checkout origin

```js
const checkout = await loadCheckout({ origin: 'https://checkout.sandbox.example' });
```

`origin` is required, and there is no default: it names the deployment the
drop-in frames and posts the session credential to, so it is chosen by whoever
loads the runtime and never filled in on their behalf. Calling `loadCheckout()`
without one throws.

This is the only place the checkout address is configurable. The runtime derives
everything else — the frame's address, the origin it will accept messages from,
the origin it posts the credential to — from where it was itself served, so there
is no per-mount option that could point one drop-in at a different checkout than
the code driving it.

## Content security policy

If your page sends a CSP, the drop-in needs two allowances:

```
script-src https://pay-checkout-staging.flw-neo.com;
frame-src  https://pay-checkout-staging.flw-neo.com;
```

The runtime carries no subresource-integrity hash, deliberately: the file behind
the URL is replaced whenever it is corrected, which is the property the whole
arrangement exists for, and a pinned hash would defeat it.

## Development

```bash
pnpm build     # tsc
pnpm test      # the loader, under jsdom
```

The runtime itself — the protocol, the frame bridge, and the host half this
package fetches — is not part of this package. It is built and tested beside the
checkout document it drives, and served from the checkout origin.
