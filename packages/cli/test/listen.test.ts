// What this CLI must get right, and what these tests pin.
//
// It is a development tool, so a failure here costs a developer an afternoon
// rather than a payment. But three of its behaviours are not cosmetic: it must
// refuse a live key (live event data is region-pinned and does not belong on a
// laptop), it must not silently skip an event it failed to deliver, because a
// developer would then believe their handler had seen everything, and it must keep
// running while their handler is down, because a tool that quietly stops forwarding
// after a server restart teaches the same false lesson.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CheckoutClient } from '@flutterwavebnw/checkout-sdk';

import { assertTestModeKey, listen, resolveTarget } from '../src/listen.js';
import { parseArgs } from '../src/cli.js';

/** An event envelope shaped like the ones the feed returns. */
function envelope(id: string, type = 'payment.succeeded') {
  return { id, type, version: 1, session_id: 'cs_1', signature: 'sig', kid: 'key_1' };
}

/**
 * A client backed by scripted feed pages, plus a recorder for what the CLI POSTed
 * to the local target. The CLI is exercised through its real SDK client, so the
 * query it builds and the response shape it expects are both covered.
 */
function harness(pages: Array<{ data: unknown[]; has_more?: boolean; next_cursor?: string | null }>) {
  const feedRequests: string[] = [];
  const delivered: Array<{ url: string; body: string; contentType: string | undefined }> = [];
  let page = 0;

  const clientFetch: typeof fetch = async (input) => {
    feedRequests.push(String(input));
    const body = pages[Math.min(page, pages.length - 1)] ?? { data: [] };
    page += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const targetFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    delivered.push({
      url: String(input),
      body: String(init?.body ?? ''),
      contentType: headers.get('Content-Type') ?? undefined,
    });
    return new Response(null, { status: 204 });
  };

  const client = new CheckoutClient({
    apiKey: 'sk_test_abc',
    baseUrl: 'https://api.test.local',
    fetch: clientFetch,
  });
  return { client, targetFetch, delivered, feedRequests };
}

test('a live key is refused, and a test key is accepted', () => {
  // The reason is residency, not preference: live event data is pinned to the
  // region it was collected in.
  assert.throws(() => assertTestModeKey('sk_live_abc'), /test-mode key only/);
  assert.throws(() => assertTestModeKey(''), /test-mode key only/);
  // The message has to say why, or a developer will assume it is a bug.
  assert.throws(() => assertTestModeKey('sk_live_abc'), /region/);
  assert.doesNotThrow(() => assertTestModeKey('sk_test_abc'));
});

test('a bare host is resolved to an http URL, and an explicit scheme is kept', () => {
  assert.equal(resolveTarget('localhost:3000/webhooks'), 'http://localhost:3000/webhooks');
  assert.equal(resolveTarget('http://localhost:3000/hook'), 'http://localhost:3000/hook');
  assert.equal(resolveTarget('https://tunnel.example.test/hook'), 'https://tunnel.example.test/hook');
});

test('events are forwarded to the local target as JSON, verbatim', async () => {
  const { client, targetFetch, delivered } = harness([
    { data: [envelope('evt_1'), envelope('evt_2', 'session.expired')], has_more: false, next_cursor: 'cur_2' },
  ]);

  const result = await listen({
    client,
    forwardTo: 'localhost:3000/webhooks',
    fetch: targetFetch,
    log: () => {},
    maxEvents: 2,
  });

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0]!.url, 'http://localhost:3000/webhooks');
  assert.equal(delivered[0]!.contentType, 'application/json');

  // The envelope arrives with its signature fields intact — a receiver has to be
  // able to verify what it was handed.
  const received = JSON.parse(delivered[0]!.body) as Record<string, unknown>;
  for (const field of ['id', 'type', 'signature', 'kid']) {
    assert.ok(field in received, `forwarded event is missing ${field}`);
  }
  assert.deepEqual(received, envelope('evt_1'));

  assert.deepEqual(
    result.forwarded.map((f) => f.id),
    ['evt_1', 'evt_2'],
  );
  assert.equal(result.forwarded[0]!.status, 204);
});

test('the feed is read with the cursor it was given, so a resume does not replay', async () => {
  const { client, targetFetch, feedRequests } = harness([{ data: [envelope('evt_9')], next_cursor: 'cur_9' }]);

  const result = await listen({
    client,
    forwardTo: 'localhost:3000/hook',
    cursor: 'cur_8',
    fetch: targetFetch,
    log: () => {},
    maxEvents: 1,
  });

  assert.ok(feedRequests[0]!.includes('cursor=cur_8'), `expected the cursor on the feed request: ${feedRequests[0]}`);
  // A bounded run stops mid-page, so the cursor stays at the boundary it started
  // from: maxEvents asks for a short run, not for the page to be acknowledged.
  assert.equal(result.cursor, 'cur_8');
});

test('a fully-delivered page advances the cursor to its end', async () => {
  const { client, targetFetch } = harness([
    { data: [envelope('evt_9')], has_more: false, next_cursor: 'cur_9' },
  ]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);

  const result = await listen({
    client,
    forwardTo: 'localhost:3000/hook',
    cursor: 'cur_8',
    fetch: targetFetch,
    log: () => {},
    pollMs: 10,
    signal: controller.signal,
  });

  // Reported so a restart resumes instead of replaying from the top.
  assert.equal(result.cursor, 'cur_9');
});

test('an undelivered event is not skipped, and the tool keeps listening', async () => {
  // The failure that would matter. If the cursor moved on, the developer's handler
  // would never see that event and they would have no way to know.
  //
  // The second half matters just as much and is deliberately unbounded: an
  // unreachable handler is almost always one that is restarting, so the run has to
  // survive it. Ending the loop on the first refusal meant a reload of the
  // developer's own server silently stopped forwarding, with a success exit code.
  const { client, feedRequests } = harness([{ data: [envelope('evt_lost')], next_cursor: 'cur_lost' }]);
  const refusing: typeof fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);

  const lines: string[] = [];
  const result = await listen({
    client,
    forwardTo: 'localhost:3000/hook',
    cursor: 'cur_before',
    fetch: refusing,
    log: (l) => lines.push(l),
    pollMs: 10,
    signal: controller.signal,
  });

  assert.equal(result.forwarded.length, 0, 'a failed delivery must not count as forwarded');
  assert.equal(result.cursor, 'cur_before', 'the cursor must not advance past an undelivered event');
  assert.ok(
    lines.some((l) => l.includes('not delivered')),
    `the failure must be reported: ${lines.join(' | ')}`,
  );
  assert.ok(
    feedRequests.length > 1,
    'the run must survive an unreachable handler and retry, not exit on the first failure',
  );
  assert.ok(
    feedRequests.every((u) => u.includes('cursor=cur_before')),
    `every retry must re-read from the unacknowledged page: ${feedRequests.join(' | ')}`,
  );
});

test('a handler that was briefly down receives the page on the next pass', async () => {
  // The promise the README and the guide both make. The first delivery attempt
  // fails; once the handler is back, the whole page arrives and only then is the
  // cursor acknowledged.
  const { client } = harness([
    { data: [envelope('e1'), envelope('e2')], has_more: false, next_cursor: 'cur_done' },
  ]);
  let attempts = 0;
  const delivered: string[] = [];
  const flaky: typeof fetch = async (_url, init) => {
    attempts += 1;
    if (attempts === 1) throw new Error('ECONNREFUSED');
    delivered.push(String(init?.body ?? ''));
    return new Response(null, { status: 204 });
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);

  const result = await listen({
    client,
    forwardTo: 'localhost:3000/hook',
    cursor: 'cur_start',
    fetch: flaky,
    log: () => {},
    pollMs: 10,
    signal: controller.signal,
  });

  assert.ok(
    delivered.some((b) => b.includes('"id":"e1"')),
    'the event whose delivery failed must be redelivered, not skipped',
  );
  assert.ok(
    delivered.some((b) => b.includes('"id":"e2"')),
    'the rest of the page must follow it',
  );
  assert.equal(result.cursor, 'cur_done', 'the page is acknowledged once it has been delivered');
});

test('the handler status is reported, including a rejection', async () => {
  // A 400 from the handler is the developer's own verification refusing a bad
  // event. It is surfaced, not hidden, and it is not treated as a transport error.
  const { client } = harness([{ data: [envelope('evt_rejected')], next_cursor: 'cur_r' }]);
  const rejecting: typeof fetch = async () => new Response('nope', { status: 400 });

  const lines: string[] = [];
  const result = await listen({
    client,
    forwardTo: 'localhost:3000/hook',
    fetch: rejecting,
    log: (l) => lines.push(l),
    maxEvents: 1,
  });

  assert.equal(result.forwarded[0]!.status, 400);
  assert.ok(
    lines.some((l) => l.includes('400')),
    `the handler status must be shown: ${lines.join(' | ')}`,
  );
});

test('an abort stops the loop without forwarding more', async () => {
  const { client, targetFetch, delivered } = harness([{ data: [envelope('evt_a')], has_more: true, next_cursor: 'c1' }]);
  const controller = new AbortController();
  controller.abort();

  const result = await listen({
    client,
    forwardTo: 'localhost:3000/hook',
    fetch: targetFetch,
    log: () => {},
    signal: controller.signal,
  });

  assert.equal(delivered.length, 0);
  assert.equal(result.forwarded.length, 0);
});

test('a caught-up feed is not re-delivered on every poll', async () => {
  // The bug this exists to catch. The feed returns a cursor on the final page too;
  // if the loop cannot advance past it, a quiet feed hammers the developer's
  // handler with the same events forever. Deliberately unbounded — an earlier
  // version of these tests capped the run with maxEvents and never reached the
  // second iteration, which is exactly where the fault was.
  let served = 0;
  const clientFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get('cursor');
    served += 1;
    // Once the caller has acknowledged the page, there is nothing left to serve.
    const data = cursor === 'cur_end' ? [] : [envelope('e1'), envelope('e2')];
    return new Response(
      JSON.stringify({ data, has_more: false, next_cursor: data.length ? 'cur_end' : null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const delivered: string[] = [];
  const targetFetch: typeof fetch = async (_u, init) => {
    delivered.push(String(init?.body ?? ''));
    return new Response(null, { status: 204 });
  };
  const client = new CheckoutClient({
    apiKey: 'sk_test_abc',
    baseUrl: 'https://api.test.local',
    fetch: clientFetch,
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await listen({
    client,
    forwardTo: 'localhost:3000/hook',
    fetch: targetFetch,
    log: () => {},
    pollMs: 10,
    signal: controller.signal,
  });

  assert.equal(delivered.length, 2, `each event must be delivered once, got ${delivered.length}`);
  assert.ok(served > 2, 'the loop should have kept polling, just with nothing new to send');
});

test('a mid-page failure does not advance the cursor past the rest of the page', async () => {
  // The cursor is a page boundary. If it moved after each event, a failure on the
  // second event would strand it behind a cursor that had already passed it.
  //
  // The middle event fails on every attempt, so the page is never acknowledged for
  // as long as the run lasts — and the events behind the failure are never handed
  // out ahead of it.
  const { client } = harness([
    { data: [envelope('e1'), envelope('e2'), envelope('e3')], has_more: false, next_cursor: 'cur_next' },
  ]);
  const delivered: string[] = [];
  const failsOnE2: typeof fetch = async (_url, init) => {
    const body = String(init?.body ?? '');
    if (body.includes('"id":"e2"')) throw new Error('ECONNRESET');
    delivered.push(body);
    return new Response(null, { status: 204 });
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);

  const result = await listen({
    client,
    forwardTo: 'localhost:3000/hook',
    cursor: 'cur_start',
    fetch: failsOnE2,
    log: () => {},
    pollMs: 10,
    signal: controller.signal,
  });

  assert.equal(
    result.cursor,
    'cur_start',
    'the cursor must stay at the page boundary so e2 and e3 are re-read, not skipped',
  );
  assert.ok(
    delivered.every((b) => b.includes('"id":"e1"')),
    'nothing behind the failing event may be delivered ahead of it',
  );
  assert.ok(
    !delivered.some((b) => b.includes('"id":"e3"')),
    'e3 sits behind the failure and must wait for it',
  );
});

test('a page of events with no cursor is refused rather than silently re-read', async () => {
  // If the server ever withholds a cursor for a non-empty page there is no safe
  // position to resume from. Failing loudly beats looping forever.
  const { client, targetFetch } = harness([{ data: [envelope('e1')], has_more: false, next_cursor: null }]);
  await assert.rejects(
    listen({ client, forwardTo: 'localhost:3000/hook', fetch: targetFetch, log: () => {} }),
    /no safe position to resume from/,
  );
});

test('argument parsing accepts the documented flags and rejects the rest', () => {
  const args = parseArgs(['listen', '--forward-to', 'localhost:3000/hook', '--poll', '250', '--cursor', 'c1']);
  assert.equal(args.command, 'listen');
  assert.equal(args.forwardTo, 'localhost:3000/hook');
  assert.equal(args.poll, 250);
  assert.equal(args.cursor, 'c1');

  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['listen', '--nope']), /unknown option/);
  assert.throws(() => parseArgs(['listen', 'extra']), /unexpected argument/);
  assert.throws(() => parseArgs(['listen', '--poll', 'soon']), /milliseconds/);
  // A flag with no value is an error rather than a silent undefined.
  assert.throws(() => parseArgs(['listen', '--forward-to']), /expects a value/);
  assert.throws(() => parseArgs(['listen', '--forward-to', '--poll', '5']), /expects a value/);
});
