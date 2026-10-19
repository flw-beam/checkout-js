# @flutterwavebnw/checkout-react

React bindings for Flutterwave Checkout. A hook that drives one `CheckoutSession`
over the browser (`client_secret`) client, plus the two components that render
what a page cannot render itself — for React web, Next.js, and React Native.

```bash
npm install https://github.com/flw-beam/checkout-js/releases/download/v0.1.0/flutterwavebnw-checkout-react-0.1.0.tgz
```

That brings `@flutterwavebnw/checkout-sdk` and `@flutterwavebnw/checkout-runtime` from
the same release. Releases are published on the
[checkout-js repository](https://github.com/flw-beam/checkout-js/releases), one tarball
per package, rather than to a registry; pnpm, yarn and bun install the same URL.
React 18 or later is a peer dependency.

```tsx
import { useCheckoutSession } from '@flutterwavebnw/checkout-react';

function Checkout({ sessionId, clientSecret }: { sessionId: string; clientSecret: string }) {
  const {
    phase, session, busy, error, watching,
    selectMethod, authorize, completeAction,
  } = useCheckoutSession({
    sessionId,
    clientSecret,
    baseUrl: '/api/checkout', // your same-origin proxy to the Checkout API
  });

  if (phase === 'loading') return <Spinner />;
  if (phase === 'error') return <ErrorView error={error} />;

  // `session` is always the authoritative snapshot checkout computed.
  return <MethodPicker session={session!} disabled={busy} onPick={(ref) => selectMethod(ref)} />;
}
```

- **Thin client.** No payment logic lives here — every action calls the Checkout
  API and the returned `session` is authoritative. State is `phase` (`loading` /
  `ready` / `error`), `session`, `methods`, `busy`, `error`, and `watching`.
- **It waits for you.** While the session is waiting on a rail — money in flight, a
  transfer to send, a wallet prompt to approve — the hook holds a live watch on the
  API's session stream, with a slow re-read beneath it. `session` moves on its own,
  `watching` says whether a watch is held, and there is no interval to write and no
  "I have paid" button to add. Pass `watch: false` to drive it yourself with
  `store.watch()`.
- **Render on `isBuyerFinal`, not `isTerminal`.** `awaiting_confirmation` means the
  buyer has paid and the rail is still settling, which on some rails is days. The
  watch stops there for that reason; a screen that checks `isTerminal` instead puts
  the payment form back in front of someone who has already paid.
- **Only browser-safe verbs.** Backed by the `client_secret` client, so it can
  drive a session (select method, set customer, authorize, complete action,
  cancel) but cannot create a session or read the timeline/confirmation.
  `quoteFx` is returned too, but cross-currency quoting is not available yet, so
  the call fails.
- **Node-free.** Session types and error classes come from `@flutterwavebnw/checkout-sdk/browser`.

## Cards, without the card touching your page

Build the checkout with the hook and mount `CardField` where the card goes: one
framed input served from the checkout origin, which posts the card straight to
the vault and hands you a token. Rendering the card yourself would put it in your
DOM and your site in the cardholder data environment.

```tsx
import { CardField, useCheckoutSession } from '@flutterwavebnw/checkout-react';

const field = useRef<CardFieldHandle | null>(null);

<CardField
  origin="https://pay-checkout-staging.flw-neo.com"
  sessionId={sessionId}
  clientSecret={clientSecret}
  appearance={{ fontFamily: 'Inter, sans-serif', borderRadius: '8px' }}
  onField={(f) => (field.current = f)}
  onChange={({ complete }) => setCanPay(complete)}
/>;

// in your submit handler:
const { token, display, issuer } = await field.current!.capture();
const priced = await selectMethod({ method: 'card', token, display, issuer });
await authorize({ expected_charge_amount: priced.charge_amount });
```

`CheckoutDropIn` is the other shape: our whole checkout inside an element of
yours, nothing to design. Give it the session, or let it ask your server for one:

```tsx
<CheckoutDropIn
  origin="https://pay-checkout-staging.flw-neo.com"
  fetchSession={() => fetch(`/api/orders/${orderId}/checkout`, { method: 'POST' }).then((r) => r.json())}
  reuseKey={orderId}
  onError={(err) => showProblem(err)}
/>
```

`origin` is required on both components, and there is no default: it names the
checkout deployment the frame is served from and the session credential is posted
to, so it is your choice and never one made for you. The session must be created
on that same deployment's API.

`fetchSession` resolves with `{ sessionId, clientSecret }`, and the component
renders straight away rather than waiting for it. `reuseKey` names the purchase: a
buyer who closes the checkout and opens it again for the same key in the same tab
lands back on the session they started, until that session ends. Pass one, or
every mount fetches — including both of StrictMode's development mounts. A new
inline `fetchSession` on each render is not a new purchase and does not remount
the frame.

A session that ended while the buyer was away still opens: its `client_secret`
keeps reading the session until 30 minutes past its expiry time, so the frame
shows the buyer how it ended and `onSession` reports it. `onClosed` fires for
what is left — a session past that window, or one whose expiry time passed
before it finished. It is not a failure: the buyer may have paid. Ask your
server, which reads the session with your API key, and mount a new checkout only
if it failed, expired, was canceled or was abandoned.

## React Native

Works as-is, with one note: the default idempotency-key generator uses Web
Crypto's `randomUUID`. On a React Native engine without it, pass your own:

```ts
useCheckoutSession({ sessionId, clientSecret, baseUrl, generateIdempotencyKey: () => myUuid() });
```

## Non-React use

The hook wraps `CheckoutSessionStore`, a framework-agnostic store (subscribe /
getSnapshot + the same actions). It lives in `@flutterwavebnw/checkout-sdk/browser`, where
every framework binding shares it, and is re-exported here for testing or other
UI layers.

## Develop

```sh
corepack pnpm --filter @flutterwavebnw/checkout-react run build
corepack pnpm --filter @flutterwavebnw/checkout-react run test   # the exports, via node:test
# the store's own tests live with it: corepack pnpm --filter @flutterwavebnw/checkout-sdk run test
```
