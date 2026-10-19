# @flutterwavebnw/checkout-vue

Vue bindings for Flutterwave Checkout. Three pieces, for the three ways a page
takes a payment:

- **`<CheckoutDropIn>`** — our whole checkout, framed inside an element of yours.
- **`<CardField>`** — one framed card input, inside a checkout you designed.
- **`useCheckoutSession()`** — the session as reactive state, to build that
  checkout over.

All three drive the same `CheckoutSession` over the session's `client_secret`,
created by your server with your API key. None of them holds payment logic, and
none puts a card number in your page. Works in Vue 3.3+ and Nuxt 3.

## Install

```bash
npm install https://github.com/flw-beam/checkout-js/releases/download/v0.1.0/flutterwavebnw-checkout-vue-0.1.0.tgz
```

That brings `@flutterwavebnw/checkout-sdk` and `@flutterwavebnw/checkout-runtime` from
the same release. Releases are published on the
[checkout-js repository](https://github.com/flw-beam/checkout-js/releases), one tarball
per package, rather than to a registry; pnpm, yarn and bun install the same URL.

## The drop-in

```vue
<script setup lang="ts">
import { CheckoutDropIn, type PublicSessionState } from '@flutterwavebnw/checkout-vue';

const props = defineProps<{ sessionId: string; clientSecret: string }>();

function onSession(session: PublicSessionState) {
  if (session.status === 'succeeded') navigateTo('/order/complete');
}
</script>

<template>
  <CheckoutDropIn
    origin="https://pay-checkout-staging.flw-neo.com"
    :session-id="props.sessionId"
    :client-secret="props.clientSecret"
    class="checkout"
    @session="onSession"
    @error="(err) => console.error(err)"
  />
</template>
```

Or let it ask your server for the session, so the page renders it straight away
rather than fetching first:

```vue
<CheckoutDropIn
  origin="https://pay-checkout-staging.flw-neo.com"
  :fetch-session="() => $fetch(`/api/orders/${orderId}/checkout`, { method: 'POST' })"
  :reuse-key="orderId"
  @error="(err) => showProblem(err)"
/>
```

`fetch-session` resolves with `{ sessionId, clientSecret }`. `reuse-key` names
the purchase: a buyer who closes the checkout and opens it again for the same key
in the same tab lands back on the session they started, until that session ends.
Without it, every mount fetches.

A session that ended while the buyer was away still opens: its `client_secret`
keeps reading the session until 30 minutes past its expiry time, so the frame
shows the buyer how it ended and `session` reports it. `closed` fires for what is
left — a session past that window, or one whose expiry time passed before it
finished. It is not a failure: the buyer may have paid. Ask your server, which
reads the session with your API key, and mount a new checkout only if it failed,
expired, was canceled or was abandoned.

Events: `session` on every status change, `step-up` when the buyer's bank opens
for authentication (`blocked: true` means the whole tab is navigating instead),
`timeout` when the frame never answered, and `error` when the runtime could not be
loaded at all. Handle `error`: it is the one case where the box simply stays
empty.

**`session` is a UI signal, not proof of payment.** It comes from a browser, and a
browser can be made to say anything. Fulfil orders from the signed
`payment.succeeded` event your server receives.

Only a change of `session-id`, `client-secret`, `reuse-key`, `origin`, or `title`
— or switching between a given and a fetched session — remounts the frame. A
class, a listener, a new `fetch-session` function, or a parent re-render never
does, so nothing a parent does mid-payment drops the buyer back to a blank frame.

## The card field

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { CardField, useCheckoutSession, type CardFieldExposed } from '@flutterwavebnw/checkout-vue';

const props = defineProps<{ sessionId: string; clientSecret: string }>();
const checkout = useCheckoutSession({ ...props, baseUrl: '/api/checkout' });
const card = ref<CardFieldExposed | null>(null);
const complete = ref(false);

async function pay() {
  const { token, display, issuer } = await card.value!.capture();
  await checkout.selectMethod({ method: 'card', token, display, issuer });
  await checkout.authorize({ expected_charge_amount: checkout.session.value!.charge_amount });
}
</script>

<template>
  <CardField
    ref="card"
    origin="https://pay-checkout-staging.flw-neo.com"
    :session-id="props.sessionId"
    :client-secret="props.clientSecret"
    :appearance="{ fontFamily: 'Inter, sans-serif', borderRadius: '8px' }"
    @change="(s) => (complete = s.complete)"
  />
  <button :disabled="!complete || checkout.busy.value" @click="pay">Pay</button>
</template>
```

The template ref is the handle: `capture()`, `focus()`, and `clear()`. A capture
with no field on the page rejects with the runtime's own codes —
`field_unreachable` before it loaded, `field_destroyed` after it went away — so a
branch on `code` reads the same with or without this package. A change to
`appearance` restyles the live field rather than remounting it, so a theme switch
never empties what the buyer typed.

## The composable

```ts
const checkout = useCheckoutSession({ sessionId, clientSecret, baseUrl: '/api/checkout' });

checkout.phase.value;    // 'loading' | 'ready' | 'error'
checkout.session.value;  // the session checkout computed
await checkout.selectMethod({ method: 'mobile_money' });
```

`baseUrl` is the Checkout API, or more commonly a same-origin proxy to it.
Options may be a plain object, a ref, or a getter; a new `sessionId`,
`clientSecret`, or `baseUrl` is a different session and gets a fresh store.

While the session waits on a rail — money in flight, a transfer to send, a wallet
prompt to approve — the composable holds a live watch, so `session` moves on its
own and nothing needs to poll. `watching` says whether one is held; pass
`watch: false` to opt out.

The composable wraps `CheckoutSessionStore` from `@flutterwavebnw/checkout-sdk/browser`, the
same store the React bindings wrap, re-exported here.

## Nuxt

Nothing to configure. Every piece mounts in `onMounted`, so a server render emits
the empty container and the `loading` state and makes no request; the frame and
the fetch happen in the browser. No `<ClientOnly>` needed.

Create the session in a server route, never in a component, so your API key stays
on the server.

## Choosing the checkout origin

```vue
<CheckoutDropIn origin="https://pay-checkout-staging.flw-neo.com" ... />
```

`origin` is required on both components, and there is no default: it names the
deployment the frame is served from and the session credential is posted to, so
it is your choice and never one made for you. The session must be created on
that same deployment's API. The runtime frames
checkout from the origin it was loaded from, so a session from another deployment
is one the frame cannot find.

## Develop

```sh
corepack pnpm --filter @flutterwavebnw/checkout-vue run build
corepack pnpm --filter @flutterwavebnw/checkout-vue run test   # the components and composable under jsdom
```
