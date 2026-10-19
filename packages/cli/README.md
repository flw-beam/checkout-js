# @flutterwavebnw/checkout-cli

Command-line tooling for Flutterwave Checkout.

```bash
npm install --global https://github.com/flw-beam/checkout-js/releases/download/v0.1.0/flutterwavebnw-checkout-cli-0.1.0.tgz
```

Releases are published on the [checkout-js repository](https://github.com/flw-beam/checkout-js/releases),
one tarball per package, rather than to a registry. Node 20 or later.

```bash
export FLW_API_KEY=sk_test_...
export FLW_BASE_URL=https://api-checkout-staging.flw-neo.com

flutterwavebnw-checkout listen --forward-to localhost:3000/webhooks
```

```
listening for test-mode events, forwarding to http://localhost:3000/webhooks
  evt_01HZ...  payment.succeeded   -> 204
  evt_01J0...  session.expired     -> 204
```

Drive a test payment and every event it produces arrives at your handler, with its
provenance signature intact — so your verification code runs against a genuine
signature rather than a fixture you built by hand.

## What it is doing

Reading the merchant event feed (`GET /v1/events`) and POSTing each event to your
target. The forwarding happens **here**, on your machine: checkout has no
registration for your laptop and never delivers to it.

That difference matters, because production works another way. There, events are
*delivered* to your registered webhook endpoint, with retries, backoff, and a
delivery history behind them. This reads a feed. Build your production integration
on webhooks; use this while you build, and for backfill.

## Behaviour worth knowing

- **Test mode only.** A live key is refused. Payment data is pinned to the region
  it was collected in, and forwarding live events to a laptop would move real
  buyers' details out of it. Use the dashboard to inspect live traffic.
- **An undelivered event is not skipped.** If your handler is unreachable, the
  cursor does not advance past the event and the command keeps running, retrying the
  page each poll until it gets through. Restarting your own server mid-session costs
  you nothing — expect the events either side of the restart to arrive twice, which
  is what `event.id` deduplication is for.
- **It tells you where it stopped.** On exit it prints a cursor; pass it back with
  `--cursor` to resume without replaying what you already processed.
- **Your handler's status is shown.** A `400` from your own verification is
  reported as a `400` — that is your code refusing an event, which is exactly what
  you want to see while you are getting it right.

## Options

| Flag | Meaning |
|---|---|
| `--forward-to <target>` | Where to POST each event. A bare host defaults to `http`. Required. |
| `--cursor <cursor>` | Resume from a feed cursor instead of the oldest retained event. |
| `--poll <ms>` | Interval between feed polls (default 1000). |
| `--base-url <url>` | API base URL, if `FLW_BASE_URL` is not set. |

`FLW_API_KEY` is required and must be a test-mode key.

## Reading the feed yourself

The CLI is a thin wrapper over one endpoint, and the SDK exposes it directly if you
want to reconcile or backfill in your own code:

```ts
const page = await checkout.listMerchantEvents({ cursor });
```

Reading forward from a cursor returns every subsequent event exactly once, so
persisting the cursor is enough to resume without gaps. Advance it only once you
have processed the whole page — it is a page boundary, not a per-event position, so
a half-processed page should be re-read rather than partially acknowledged. Events
age out of the feed after a retention window; for one session's full history use
`listEvents(id)`.
