// The session watch. What is worth testing here is not that a happy stream
// arrives — it is the behaviour that decides whether a real integration is
// correct on a noisy network: that a chunk boundary in the middle of a frame does
// not drop a snapshot, that a stale version is never handed back after a newer
// one, that a refused or dead stream still resolves through the poll beneath it,
// and that stopping is never dressed up as an outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Imported rather than taken from the global: the SDK compiles against ES2022 +
// Node types with no DOM lib, so the web stream type is only nameable here.
import { ReadableStream } from 'node:stream/web';
import { CheckoutClient } from '../src/client.js';
import { CheckoutBrowserClient } from '../src/browser.js';
import { CheckoutError } from '../src/errors.js';
import type { CheckoutSession, CoreError } from '../src/types.js';

const BASE = 'https://api.flutterwave.test/checkout';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** One session state, with only the fields the watch itself reads. */
function session(version: number, status: string): CheckoutSession {
  return { id: 'cs_1', version, status } as unknown as CheckoutSession;
}

/** An SSE frame carrying one snapshot, framed as the core frames it. */
function frame(snapshot: CheckoutSession): string {
  return `id: ${snapshot.version}\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

function coreError(code: string): CoreError {
  return {
    code,
    category: 'validation',
    message_human: 'no',
    message_machine: code,
    suggested_action: 'contact_support',
    retriable: false,
    request_id: 'req_1',
  } as CoreError;
}

interface StubOptions {
  /** Session states the plain read returns, in order (the last one repeats). */
  reads: CheckoutSession[];
  /** Body chunks each stream connection serves, one array per connection. */
  streams?: string[][];
  /** Status for a stream connection with no chunks left to serve. Default 200 (empty). */
  streamStatus?: number;
  /** Status for reads once `reads` is exhausted. */
  readStatus?: number;
}

/**
 * A fetch stub that answers the session read with JSON and the session stream
 * with a chunked SSE body, recording every call so the resume header and the
 * fallback behaviour can be asserted.
 */
function stub(options: StubOptions) {
  const reads: Call[] = [];
  const streams: Call[] = [];
  let readIndex = 0;
  let streamIndex = 0;
  const encoder = new TextEncoder();

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const headers = (init?.headers as Record<string, string>) ?? {};
    if (target.endsWith('/stream')) {
      streams.push({ url: target, headers });
      const chunks = options.streams?.[streamIndex++];
      if (!chunks) {
        const status = options.streamStatus ?? 200;
        return new Response(status === 200 ? '' : JSON.stringify(coreError('rate_limited')), {
          status,
          headers: status === 200 ? undefined : { 'retry-after': '1' },
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    reads.push({ url: target, headers });
    const next = options.reads[Math.min(readIndex++, options.reads.length - 1)];
    if (next === undefined) {
      return new Response(JSON.stringify(coreError('session_not_found')), {
        status: options.readStatus ?? 404,
      });
    }
    if (options.readStatus !== undefined && readIndex > options.reads.length) {
      return new Response(JSON.stringify(coreError('session_not_found')), {
        status: options.readStatus,
      });
    }
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, reads, streams };
}

function client(fetchImpl: typeof fetch) {
  return new CheckoutClient({ apiKey: 'sk_test_1', baseUrl: BASE, fetch: fetchImpl });
}

async function collect(
  watch: AsyncIterable<CheckoutSession>,
): Promise<Array<{ version: number; status: string }>> {
  const seen: Array<{ version: number; status: string }> = [];
  for await (const snapshot of watch) seen.push({ version: snapshot.version, status: snapshot.status });
  return seen;
}

test('yields the session as it stands, then each newer state from the stream', async () => {
  const s = stub({
    reads: [session(1, 'processing')],
    streams: [[frame(session(2, 'pending')), frame(session(3, 'succeeded'))]],
  });
  const seen = await collect(client(s.fetch).watchSession('cs_1'));

  assert.deepEqual(seen, [
    { version: 1, status: 'processing' },
    { version: 2, status: 'pending' },
    { version: 3, status: 'succeeded' },
  ]);
  assert.equal(s.reads[0]!.url, `${BASE}/v1/checkout_sessions/cs_1`);
  assert.equal(s.streams[0]!.url, `${BASE}/v1/checkout_sessions/cs_1/stream`);
  assert.equal(s.streams[0]!.headers['Accept'], 'text/event-stream');
  assert.equal(s.streams[0]!.headers['Authorization'], 'Bearer sk_test_1');
});

// The failure this guards against is invisible against a fast local core and
// routine on a mobile network: a frame split across two TCP reads.
test('reassembles a snapshot split across chunk boundaries', async () => {
  const whole = frame(session(2, 'succeeded'));
  const s = stub({
    reads: [session(1, 'processing')],
    streams: [[whole.slice(0, 12), whole.slice(12, 30), whole.slice(30)]],
  });
  const seen = await collect(client(s.fetch).watchSession('cs_1'));
  assert.deepEqual(seen.at(-1), { version: 2, status: 'succeeded' });
});

test('ignores keep-alive comments and unparseable frames', async () => {
  const s = stub({
    reads: [session(1, 'processing')],
    streams: [
      [
        ': keep-alive\n\n',
        'id: 2\ndata: {not json\n\n',
        'id: 3\ndata: {"id":"cs_1","status":"succeeded"}\n\n', // no version: cannot be ordered
        frame(session(4, 'succeeded')),
      ],
    ],
  });
  const seen = await collect(client(s.fetch).watchSession('cs_1'));
  assert.deepEqual(seen, [
    { version: 1, status: 'processing' },
    { version: 4, status: 'succeeded' },
  ]);
});

// A stream of states, not of deltas: a version at or below the newest one held
// carries nothing, and handing it back would walk a caller's UI backwards.
test('drops a snapshot that is not newer than the one already yielded', async () => {
  const s = stub({
    reads: [session(5, 'processing')],
    streams: [[frame(session(4, 'authorizing')), frame(session(5, 'processing')), frame(session(6, 'succeeded'))]],
  });
  const seen = await collect(client(s.fetch).watchSession('cs_1'));
  assert.deepEqual(seen, [
    { version: 5, status: 'processing' },
    { version: 6, status: 'succeeded' },
  ]);
});

test('an already-finished session yields once and opens no stream', async () => {
  const s = stub({ reads: [session(9, 'succeeded')] });
  const seen = await collect(client(s.fetch).watchSession('cs_1'));
  assert.deepEqual(seen, [{ version: 9, status: 'succeeded' }]);
  assert.equal(s.streams.length, 0, 'a state that cannot change is not worth a connection');
});

// awaiting_confirmation is buyer-final without being terminal: the buyer has paid
// and the rail may take days, so a watch must not hold them for it.
test('stops when the buyer has nothing left to do, including awaiting_confirmation', async () => {
  const s = stub({
    reads: [session(1, 'processing')],
    streams: [[frame(session(2, 'awaiting_confirmation'))]],
  });
  const seen = await collect(client(s.fetch).watchSession('cs_1'));
  assert.deepEqual(seen.at(-1), { version: 2, status: 'awaiting_confirmation' });
});

test('until can hold the watch open past awaiting_confirmation', async () => {
  const s = stub({
    reads: [session(1, 'processing')],
    streams: [[frame(session(2, 'awaiting_confirmation')), frame(session(3, 'succeeded'))]],
  });
  const seen = await collect(
    client(s.fetch).watchSession('cs_1', { until: (x) => x.status === 'succeeded' }),
  );
  assert.deepEqual(seen.map((x) => x.status), ['processing', 'awaiting_confirmation', 'succeeded']);
});

// Terminal is terminal: a session that can no longer change has nothing left to
// watch, whatever condition the caller asked to wait for.
test('a terminal state ends the watch even when until never holds', async () => {
  const s = stub({
    reads: [session(1, 'processing')],
    streams: [[frame(session(2, 'failed'))]],
  });
  const seen = await collect(
    client(s.fetch).watchSession('cs_1', { until: () => false, pollIntervalMs: 1_000 }),
  );
  assert.deepEqual(seen.at(-1), { version: 2, status: 'failed' });
});

test('sends the version already held as the SSE resume header on reconnect', async () => {
  const s = stub({
    reads: [session(1, 'processing')],
    // The first connection delivers a state and ends; the watch reconnects.
    streams: [[frame(session(2, 'pending'))], [frame(session(3, 'succeeded'))]],
  });
  const seen = await collect(client(s.fetch).watchSession('cs_1', { pollIntervalMs: 1_000 }));

  assert.deepEqual(seen.at(-1), { version: 3, status: 'succeeded' });
  assert.equal(s.streams[0]!.headers['Last-Event-ID'], '1', 'the state the read produced');
  assert.equal(s.streams[1]!.headers['Last-Event-ID'], '2', 'the newest state now held');
});

// The point of the layering: no single connection is load-bearing.
test('resolves through the poll when the stream is refused outright', async () => {
  const s = stub({
    reads: [session(1, 'processing'), session(2, 'succeeded')],
    streamStatus: 429,
  });
  const degraded: unknown[] = [];
  const seen = await collect(
    client(s.fetch).watchSession('cs_1', {
      pollIntervalMs: 1_000,
      onDegraded: (err) => degraded.push(err),
    }),
  );

  assert.deepEqual(seen, [
    { version: 1, status: 'processing' },
    { version: 2, status: 'succeeded' },
  ]);
  assert.ok(degraded.length >= 1, 'the refusal is reported');
  assert.ok(degraded[0] instanceof CheckoutError && degraded[0].status === 429);
});

test('a read failure the core will never satisfy is thrown, not waited out', async () => {
  const s = stub({ reads: [session(1, 'processing')], readStatus: 404, streamStatus: 200 });
  await assert.rejects(
    () => collect(client(s.fetch).watchSession('cs_1', { pollIntervalMs: 1_000 })),
    (err: unknown) => err instanceof CheckoutError && err.status === 404,
  );
});

test('an unusable credential fails at the call site rather than as a silent watch', async () => {
  const s = stub({ reads: [], readStatus: 401 });
  await assert.rejects(
    () => collect(client(s.fetch).watchSession('cs_1')),
    (err: unknown) => err instanceof CheckoutError,
  );
});

test('waitForSession returns the last state seen', async () => {
  const s = stub({
    reads: [session(1, 'processing')],
    streams: [[frame(session(2, 'pending')), frame(session(3, 'succeeded'))]],
  });
  const final = await client(s.fetch).waitForSession('cs_1');
  assert.equal(final.status, 'succeeded');
  assert.equal(final.version, 3);
});

// A deadline says nothing about whether money moved. Returning the live session
// is what lets a caller tell "still in flight" from "did not collect"; throwing
// would invite a catch block that treats a slow rail as a failure.
test('an elapsed deadline returns the live session rather than throwing', async () => {
  const s = stub({ reads: [session(1, 'processing')], streamStatus: 200 });
  const final = await client(s.fetch).waitForSession('cs_1', {
    timeoutMs: 150,
    pollIntervalMs: 1_000,
  });
  assert.equal(final.status, 'processing');
});

test('aborting the caller signal ends the watch', async () => {
  const s = stub({ reads: [session(1, 'processing')], streamStatus: 200 });
  const controller = new AbortController();
  const watching = collect(client(s.fetch).watchSession('cs_1', { signal: controller.signal }));
  controller.abort();
  const seen = await watching;
  assert.deepEqual(seen, [{ version: 1, status: 'processing' }]);
});

// Breaking out of the loop must tear the connection down; a watch that leaked one
// per abandoned loop would hold the session's single stream slot against the next
// watcher.
test('leaving the loop early closes the stream', async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).endsWith('/stream')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame(session(2, 'pending'))));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response(JSON.stringify(session(1, 'processing')), { status: 200 });
  }) as unknown as typeof fetch;

  for await (const snapshot of client(fetchImpl).watchSession('cs_1')) {
    if (snapshot.version === 2) break;
  }
  // The teardown is asynchronous: leaving the loop aborts, and the cancel lands on
  // the next turn. This waits for that turn rather than for a duration.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('the browser client watches with the session-scoped credential', async () => {
  const s = stub({
    reads: [session(1, 'processing')],
    streams: [[frame(session(2, 'succeeded'))]],
  });
  const browser = new CheckoutBrowserClient({
    clientSecret: 'sec_abc',
    baseUrl: BASE,
    fetch: s.fetch,
    surface: 'inline',
  });
  const final = await browser.waitForSession('cs_1');

  assert.equal(final.status, 'succeeded');
  assert.equal(s.streams[0]!.headers['X-Client-Secret'], 'sec_abc');
  assert.equal(s.streams[0]!.headers['X-Checkout-Surface'], 'inline');
  assert.equal(s.streams[0]!.headers['Authorization'], undefined, 'no merchant key in a browser');
});
