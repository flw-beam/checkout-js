# @flutterwavebnw/checkout-sdk

The TypeScript-first SDK for Flutterwave Checkout. A thin, typed client over the
one headless collection API, in two flavours:

- **`@flutterwavebnw/checkout-sdk`** (this entry) — the **server** client (your API key), plus
  the Ed25519 event-provenance verifier. Node.
- **`@flutterwavebnw/checkout-sdk/browser`** — the **browser** client (`client_secret`),
  node-free so it bundles for the browser. Drives one session; cannot create,
  read the timeline, or read the confirmation.

Both are thin, typed clients over the one headless collection API.

- **Types come from the API contract.** Sessions, money, errors, and every request
  body are the canonical contract types (via `@flutterwavebnw/checkout-contracts`). The SDK
  adds no session shape of its own and no back channel — it renders and drives
  the same `CheckoutSession` every surface does.
- **Server-side only.** Authenticate with your Flutterwave API key. Never ship it to
  a browser — browser surfaces use the session-scoped `client_secret`.
- **Idempotent by default.** Every mutating call carries an `Idempotency-Key`;
  the client generates one per call, or you pass your own to make a retry of the
  same logical action safe. Every mutating verb takes one; there is no non-idempotent
  verb and deliberately carries no key.

## Install

```bash
npm install https://github.com/flw-beam/checkout-js/releases/download/v0.1.0/flutterwavebnw-checkout-sdk-0.1.0.tgz
```

Releases are published on the [checkout-js repository](https://github.com/flw-beam/checkout-js/releases),
one tarball per package, rather than to a registry; pnpm, yarn and bun install the
same URL. Node 20 or later.

## Client

```ts
import { CheckoutClient } from '@flutterwavebnw/checkout-sdk';

const checkout = new CheckoutClient({
  apiKey: process.env.FLW_API_KEY!,    // your API key (bearer), server-side only
  baseUrl: process.env.FLW_BASE_URL!,  // the Checkout API: https://api-checkout-staging.flw-neo.com while testing
});

const session = await checkout.createSession({
  amount: { value: 1500, currency: 'NGN' },
  line_items: [{ name: 'Order #1001', quantity: 1, unit_amount: { value: 1500, currency: 'NGN' } }],
  actor: { type: 'merchant_server', id: 'orders_service' },
  origin_surface: 'hosted',
});
// redirect the buyer to session.url (the hosted page, secret included), or hand
// session.client_secret to a browser surface of your own to drive the payment
```

Errors surface as `CheckoutError` (the Checkout API returned its stable `Error`
shape — branch on `.code` / `.category` / `.suggestedAction`, honour `.retryAfter`)
or `CheckoutConnectionError` (the API was unreachable or returned an unexpected
body). Every request has a timeout (default 30s) and accepts an `AbortSignal`.

## Waiting out a rail

A collection on a bank transfer or a mobile-money prompt is resolved rail-side,
long after your call returns. Watch the session instead of writing a polling loop:

```ts
for await (const state of checkout.watchSession(sessionId)) {
  console.log(state.status);           // the same session getSession returns
}

// Or, when only the last state matters:
const final = await checkout.waitForSession(sessionId, { timeoutMs: 120_000 });
```

`watchSession` holds the API's live session stream and keeps a slow re-read
beneath it, so a state change arrives within a second of checkout knowing and the
outcome still arrives if the stream never connects, is refused, or dies on a
constrained network. Each value is a full `CheckoutSession`, never a delta;
intermediate states may be skipped, so branch on the state you hold. Both stop once
the buyer has nothing left to do, and both accept `signal`, `timeoutMs`, `until`,
and `onDegraded`.

Stopping is not an outcome — an elapsed `timeoutMs` returns the live session rather
than throwing, because a slow rail is not a failure. And a watch is not a webhook:
it lives as long as the process holding it, so a service takes its outcomes from
`payment.succeeded`, which is committed with the transition and retried until
delivered.

## Browser client (`client_secret`)

For a browser surface driving a single session. It sends the session-scoped
`client_secret` (never your API key) and exposes only the verbs a browser may
drive. Point `baseUrl` at a same-origin proxy that forwards to the Checkout API
(the pattern the hosted surface uses), or at the Checkout API directly where CORS
permits.

```ts
import { CheckoutBrowserClient } from '@flutterwavebnw/checkout-sdk/browser';

const checkout = new CheckoutBrowserClient({
  clientSecret,                 // from the session's client_secret, session-scoped
  baseUrl: '/api/checkout',     // your same-origin proxy to the Checkout API
});

await checkout.selectMethod(sessionId, { method: 'card', token });
const session = await checkout.authorize(sessionId, { expected_charge_amount });

// Then hold the session's live state, so a checkout you built yourself never
// polls: each snapshot is the session checkout computed, and the loop ends when
// the buyer has nothing left to do.
for await (const state of checkout.watchSession(sessionId, { signal })) render(state);
```

## Holding a session as state

A UI rarely wants one call at a time; it wants the session as state that moves
forward. `CheckoutSessionStore` is that, on the same browser client: it holds the
current session, exposes the same verbs, and applies every response and watch
snapshot in version order, so an older state never lands on screen after a newer
one. It is framework-agnostic — `subscribe` and `getSnapshot`, nothing else — and
is what `@flutterwavebnw/checkout-react` wraps, so a page with no framework can drive a
session exactly as a React one does.

```ts
import { CheckoutSessionStore, isWaitingOnRail } from '@flutterwavebnw/checkout-sdk/browser';

const store = new CheckoutSessionStore({ sessionId, clientSecret, baseUrl: '/api/checkout' });
store.subscribe(() => {
  const { phase, session, busy, error } = store.getSnapshot();
  render({ phase, session, busy, error });
  if (session && isWaitingOnRail(session)) store.watch(); // a no-op if one is running
});
await store.load();
```

## Webhook / event provenance

Every event checkout emits — on a session's `/events` timeline and in webhook
deliveries to your endpoint — carries an Ed25519 signature over its RFC 8785
canonical bytes, selected by `kid` from the keys published at
`GET /v1/signing_keys`. Verify it before you trust an event:

```ts
import { Webhooks } from '@flutterwavebnw/checkout-sdk';

const webhooks = new Webhooks({ client: checkout }); // fetches + caches the JWKS, refreshes on rotation

// in your webhook handler (verify the RAW body before parsing/trusting it):
const event = await webhooks.verify(rawRequestBody);
// throws WebhookVerificationError on a bad signature, unknown kid, or stale timestamp
```

`verify` also enforces a freshness window (default ±5 min) as replay protection.
This checks checkout's **provenance** signature — that the event genuinely
originated from checkout. Webhook delivery adds a separate **transport** signature
of its own; that one is not what `verify` checks.

## Develop

```sh
corepack pnpm --filter @flutterwavebnw/checkout-sdk run build      # emit dist/
corepack pnpm --filter @flutterwavebnw/checkout-sdk run typecheck
corepack pnpm --filter @flutterwavebnw/checkout-sdk run test        # compile + node:test
```
