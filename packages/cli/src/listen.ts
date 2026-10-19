// Forwarding real events to a handler on the developer's own machine.
//
// The core does not deliver to a laptop and holds no registration for one: it
// exposes a merchant-scoped read, and this reads it and POSTs onward. That is why
// forwarding is a client-side concern — production delivery belongs to the
// webhook service, with the retries and delivery history that implies.
//
// Events are forwarded with their provenance signature intact and nothing re-signed,
// so a developer's verifier runs against a genuine signature rather than a fixture.
//
// The bytes are not identical to the ones the core sent: the SDK hands back parsed
// JSON, so this re-serializes it before POSTing. That is safe because the signature
// covers the envelope's RFC 8785 canonical form, which a verifier recomputes from
// the parsed object — key order in the transport bytes is not part of what was
// signed. A verifier that hashed the raw body instead would be wrong against a real
// webhook too, so this does not teach the wrong lesson; it just is not byte-preserving,
// and claiming otherwise would invite exactly that mistake.
import type { CheckoutClient } from '@flutterwavebnw/checkout-sdk';

/** A test-mode key prefix. A live key is refused, see assertTestModeKey. */
const TEST_KEY_PREFIX = 'sk_test_';

export interface ListenOptions {
  client: CheckoutClient;
  /** Where to POST each event, e.g. "localhost:3000/webhooks". */
  forwardTo: string;
  /** Resume from this feed cursor instead of the oldest retained event. */
  cursor?: string;
  /** How long to wait between polls of the feed, in ms. Default 1000. */
  pollMs?: number;
  /** Injectable fetch, for tests and for runtimes without a global. */
  fetch?: typeof fetch;
  /** Where progress lines go. Default stdout. */
  log?: (line: string) => void;
  /** Stops the loop. */
  signal?: AbortSignal;
  /** Stop once this many events have been forwarded. Unset means run until aborted. */
  maxEvents?: number;
}

export interface ForwardedEvent {
  id: string;
  type: string;
  /** The HTTP status the local handler answered with. */
  status: number;
}

export interface ListenResult {
  forwarded: ForwardedEvent[];
  /** The cursor to resume from next time. */
  cursor?: string;
}

/**
 * A live key is refused rather than supported.
 *
 * The reason is data residency, not preference: payment data is pinned to the
 * region it was collected in, and streaming live events to a developer's machine
 * would move real buyers' details out of that region. Debugging live traffic
 * belongs in the dashboard, where access is scoped and audited.
 *
 * A key is bound to exactly one mode, so this is close to self-enforcing — a test
 * key cannot see live events at all. The check exists so that presenting a live
 * key fails immediately and legibly, instead of appearing to work and quietly
 * showing nothing.
 */
export function assertTestModeKey(apiKey: string): void {
  if (!apiKey.startsWith(TEST_KEY_PREFIX)) {
    throw new Error(
      'flutterwavebnw-checkout listen accepts a test-mode key only (sk_test_...). ' +
        'Live event data is pinned to its region and is not forwarded to a local machine; ' +
        'use the dashboard to inspect live traffic.',
    );
  }
}

/** Normalizes a target into an absolute URL, defaulting to http for a bare host. */
export function resolveTarget(forwardTo: string): string {
  if (/^https?:\/\//.test(forwardTo)) return forwardTo;
  return `http://${forwardTo}`;
}

/**
 * Reads the merchant event feed and forwards each event to the local target,
 * resuming from `cursor`.
 *
 * A forwarding failure is reported and does not stop the loop or lose the event's
 * place: the cursor only advances past events that were delivered, so a handler
 * that was briefly down sees them on the next pass. That mirrors what a real
 * delivery mechanism does, which is the point — the developer should be exercising
 * the same retry-shaped behaviour they will meet in production.
 */
export async function listen(options: ListenOptions): Promise<ListenResult> {
  const {
    client,
    forwardTo,
    pollMs = 1000,
    log = (line: string) => process.stdout.write(line + '\n'),
    signal,
    maxEvents,
  } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const target = resolveTarget(forwardTo);

  const forwarded: ForwardedEvent[] = [];
  let cursor = options.cursor;

  while (!signal?.aborted) {
    const page = await client.listMerchantEvents({ cursor, limit: 50 });
    const events = page.data ?? [];

    // Set when the local target could not be reached at all. The page is then left
    // unacknowledged and retried, rather than the run ending.
    let undelivered = false;

    // The cursor is a PAGE boundary, not a per-event position: the feed read
    // returns one cursor for the page, so there is no position to acknowledge an
    // individual event at. It therefore advances only once every event on the page
    // has been delivered. Advancing it mid-page would strand the rest of the page
    // behind a cursor that had already moved past them.
    for (const event of events) {
      if (signal?.aborted) return { forwarded, cursor };
      // The envelope is re-serialized here only because the SDK hands back parsed
      // JSON. The verifier recomputes the canonical form itself rather than
      // trusting byte order, so the signature still verifies.
      const body = JSON.stringify(event);
      let status = 0;
      try {
        const res = await doFetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        status = res.status;
      } catch (err) {
        log(`  ${eventLabel(event)}  -> not delivered (${describe(err)}); retrying`);
        // Stop working this page and leave the cursor where it started, so this
        // event and the rest of its page are re-read on the next pass. Keep
        // listening: an unreachable target is usually a handler that is restarting,
        // and ending the run there would mean a reload of the developer's own server
        // silently stops forwarding.
        undelivered = true;
        break;
      }
      log(`  ${eventLabel(event)}  -> ${status}`);
      forwarded.push({ id: idOf(event), type: typeOf(event), status });

      if (maxEvents !== undefined && forwarded.length >= maxEvents) {
        // Stopping early leaves the cursor where the page started: the caller
        // asked for a bounded run, not for the page to be acknowledged.
        return { forwarded, cursor };
      }
    }

    // A page that could not be delivered is retried from the same cursor after the
    // poll interval, for as long as the tool runs. Re-reading it redelivers the
    // events that did get through before the failure, which is why a handler
    // deduplicates on `event.id` — the same at-least-once shape as production
    // delivery, which is the behaviour a developer should be building against.
    if (undelivered) {
      await sleep(pollMs, signal);
      continue;
    }

    // The whole page is delivered, so it is now safe to move on. The feed returns
    // a cursor whenever a page carried events, including the last one — without
    // that, a caught-up consumer could never advance and would re-read the same
    // events on every poll.
    if (events.length > 0) {
      if (!page.next_cursor) {
        throw new Error(
          'the feed returned events with no next_cursor, so there is no safe position to resume from',
        );
      }
      cursor = page.next_cursor;
    }

    if (page.has_more) continue;
    if (signal?.aborted) break;
    await sleep(pollMs, signal);
  }

  return { forwarded, cursor };
}

function idOf(event: unknown): string {
  return String((event as { id?: unknown }).id ?? '');
}

function typeOf(event: unknown): string {
  return String((event as { type?: unknown }).type ?? '');
}

function eventLabel(event: unknown): string {
  return `${idOf(event).padEnd(30)} ${typeOf(event)}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
