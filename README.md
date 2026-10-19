# Flutterwave Checkout for JavaScript and TypeScript

The server SDK, the browser runtime, and the React and Vue bindings for
Flutterwave Checkout. Every integration drives one checkout session: your server
creates it, and a hosted page, a drop-in on your own page, a checkout you build,
or your server alone takes the buyer through to payment.

| Package | Use it for | Runs in |
|---|---|---|
| [`@flutterwavebnw/checkout-sdk`](packages/sdk-js) | Creating and driving sessions with your secret key, following a session until it settles, verifying signed events | Node.js 20+, with a `/browser` entry for a session's `client_secret` |
| [`@flutterwavebnw/checkout-runtime`](packages/runtime) | Loading the drop-in checkout and the inline card field | Browser |
| [`@flutterwavebnw/checkout-react`](packages/sdk-react) | `CheckoutDropIn`, `CardField` and `useCheckoutSession` | React, Next.js, React Native |
| [`@flutterwavebnw/checkout-vue`](packages/sdk-vue) | `CheckoutDropIn`, `CardField` and `useCheckoutSession` | Vue 3.3+, Nuxt 3 |
| [`@flutterwavebnw/checkout-cli`](packages/cli) | `flutterwavebnw-checkout listen`, which forwards test-mode events to your machine | Node.js 20+ |
| [`@flutterwavebnw/checkout-contracts`](packages/contracts-ts) | The API's types; the SDK brings it | Anywhere |

## Install

Releases are published on this repository's
[Releases page](https://github.com/flw-beam/checkout-js/releases), not to a
registry: one tarball per package, all at one version. Install a package from
its URL, and it brings the packages it depends on from the same release.

```bash
# Server
npm install https://github.com/flw-beam/checkout-js/releases/download/v0.1.0/flutterwavebnw-checkout-sdk-0.1.0.tgz

# React (brings the SDK and the runtime)
npm install https://github.com/flw-beam/checkout-js/releases/download/v0.1.0/flutterwavebnw-checkout-react-0.1.0.tgz

# Vue (brings the SDK and the runtime)
npm install https://github.com/flw-beam/checkout-js/releases/download/v0.1.0/flutterwavebnw-checkout-vue-0.1.0.tgz
```

pnpm, yarn and bun install the same URLs. Your lockfile records each tarball's
digest, and a published release's assets cannot be replaced, so a URL keeps
meaning the same bytes.

To upgrade, change the version in both places in each URL, the tag (`v0.1.0`)
and the file name (`-0.1.0.tgz`), and take every Checkout package from the same
release.

## A first payment

```ts
import { CheckoutClient } from '@flutterwavebnw/checkout-sdk';

const checkout = new CheckoutClient({
  apiKey: process.env.FLW_API_KEY!,   // your secret key, server-side only
  baseUrl: process.env.FLW_BASE_URL!, // the Checkout API: https://api-checkout-staging.flw-neo.com while testing
});

const session = await checkout.createSession({
  amount: { value: 250_000, currency: 'KES' }, // integer minor units: 2,500.00 KES
  line_items: [{ name: 'Two tickets', quantity: 2, unit_amount: { value: 125_000, currency: 'KES' } }],
  customer: { email: 'buyer@example.com', phone: '+254700000000', country: 'KE', locale: 'en-KE' },
  actor: { type: 'merchant_server', id: 'orders_service' },
  origin_surface: 'hosted',
});

res.redirect(303, session.url!); // the hosted checkout page for this session
```

Then listen for `payment.succeeded` rather than waiting for the buyer to come
back, and verify every event before acting on it:

```ts
import { Webhooks } from '@flutterwavebnw/checkout-sdk';

const webhooks = new Webhooks({ client: checkout });  // once, at startup
const event = await webhooks.verify(rawRequestBody);  // throws unless checkout signed it
```

Each package's README covers the rest: [the SDK](packages/sdk-js), [the drop-in
and the card field](packages/runtime), [React](packages/sdk-react),
[Vue](packages/sdk-vue), and [local event forwarding](packages/cli).

## Verify what you installed

Every asset is built from the tagged commit by this repository's
[Release workflow](.github/workflows/release.yml), which attests its build
provenance:

```bash
gh attestation verify flutterwavebnw-checkout-sdk-0.1.0.tgz --repo flw-beam/checkout-js
```

Each release also lists every asset's SHA-256 digest in `SHA256SUMS`.

## Versions

Every package here shares one version, and every release carries all of them.
Versions follow semantic versioning. While the major version is 0, a minor
release can include breaking changes; [CHANGELOG.md](CHANGELOG.md) says what
changed in each.

## How this repository works

The code here is developed in Flutterwave's internal repository and arrives
whole, one commit per sync, each naming the internal commit it came from.
Releases are built here, in public.

Issues are welcome. Pull requests are read but not merged as they stand, because
the next sync replaces every file: a maintainer makes the change upstream, and it
arrives with a later sync. See [CONTRIBUTING.md](CONTRIBUTING.md).

Report a security problem privately, as [SECURITY.md](SECURITY.md) describes,
never in an issue.

## License

[MIT](LICENSE)
