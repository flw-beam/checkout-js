// Watching one session, so nobody has to write a polling loop.
//
// A collection on a bank transfer or an M-Pesa prompt is resolved rail-side,
// minutes or hours after the caller's part is done. Without this, every
// integration writes the same loop — and writes it badly: a tight interval that
// hammers the API, or a slow one that leaves a buyer on a spinner long after the
// money landed. This holds the core's session stream open, hands back each
// snapshot the core computed, and keeps a slow re-read running underneath so the
// outcome still arrives when the stream never connects or quietly dies.
//
// Four properties are load-bearing rather than incidental:
//
//   * Each snapshot is the same CheckoutSession the session read returns — no
//     envelope, no delta, no change list. A caller applies a snapshot exactly as
//     it applies a read, and the newest one is always sufficient on its own.
//   * Intermediate states may be skipped. This is a stream of states, not of
//     transitions, so a watcher must never count snapshots or reconstruct a
//     history from them; the session timeline is where history lives.
//   * The watch is a read optimization and never a delivery mechanism. It is not
//     a substitute for a webhook: `payment.succeeded` reaches the merchant's
//     server through the core's transactional outbox whether or not anyone is
//     watching, and a server that only learns outcomes by watching loses them
//     the moment the process restarts.
//   * Stopping is not an outcome. A deadline, an abort, or a dropped connection
//     says nothing about whether money moved. The caller reads the status of the
//     snapshot it holds, and a session still live at that point is still live.
import { CheckoutError, CheckoutConnectionError } from './errors.js';
import { SESSIONS, encodeId, type Transport } from './http.js';
import { isBuyerFinal, isTerminal } from './types.js';
import type { CheckoutSession } from './types.js';

// How often the watch re-reads the session, alongside the live stream.
//
// The stream is what makes an outcome land promptly; this is the floor beneath
// it, and it is deliberately slow because it is no longer the mechanism. It
// exists for the connection that never opened, was buffered by a proxy, was
// refused because another watcher holds the session, or died quietly on a
// constrained mobile network — which is the workload here. Without it a caller's
// outcome would depend on one long-lived connection surviving.
const DEFAULT_POLL_INTERVAL_MS = 20_000;

// The shortest poll floor a caller may ask for, so a mistaken 0 or a tight
// interval cannot turn a watch into a hot loop against the checkout API. Nothing
// below this makes an answer arrive sooner anyway: checkout learns the rail's
// outcome by status inquiry, and the stream already relays it the moment it
// does.
const MIN_POLL_INTERVAL_MS = 1_000;

// How long a connection may go without bytes before it is treated as dead.
//
// The core writes a keep-alive comment on a quiet stream, so silence past this
// bound means the connection is gone in a way TCP has not noticed yet — routine
// on mobile networks and behind intermediaries. Dropping it and reconnecting is
// what turns a silently dead socket back into a live one.
const STALL_TIMEOUT_MS = 60_000;

// Reconnect backoff bounds. The core holds one stream per session, so a second
// watcher displaces the first; jitter and a ceiling keep two watchers from
// trading the connection back and forth in lockstep, and the poll floor means
// neither is left blind while they settle.
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 8_000;

/** What the watch needs from a client: the scoped read, and the scoped stream. */
export interface SessionSource {
  read(id: string, signal: AbortSignal): Promise<CheckoutSession>;
  openStream(id: string, lastVersion: number | undefined, signal: AbortSignal): Promise<Response>;
}

/**
 * Binds the two session reads a watch uses to a transport, so the server client
 * and the browser client watch through their own credential and see exactly what
 * a read of that session would show them. Whose credential it is decides what the
 * watch can see; the watch itself confers nothing.
 */
export function sessionSource(http: Transport): SessionSource {
  return {
    read: (id, signal) =>
      http.request<CheckoutSession>('GET', `${SESSIONS}/${encodeId(id)}`, { signal }),
    openStream: (id, lastVersion, signal) =>
      http.openStream(`${SESSIONS}/${encodeId(id)}/stream`, {
        // The standard SSE resume header, carrying the version already held: the
        // core answers a reconnect with the current session when that version is
        // behind and with silence when it is not, so reconnecting cannot replay a
        // state the caller has moved past.
        headers: lastVersion !== undefined ? { 'Last-Event-ID': String(lastVersion) } : undefined,
        signal,
      }),
  };
}

export interface WatchOptions {
  /** Stops the watch. */
  signal?: AbortSignal;
  /**
   * Stop once this holds of a snapshot. Defaults to the buyer having nothing
   * left to do (`isBuyerFinal`), which includes `awaiting_confirmation` — a
   * buyer who has paid a slow rail should not be held while it settles, which in
   * some markets is days.
   *
   * Pass `(s) => isTerminal(s.status)` to wait for the record to be final
   * instead, and pair it with `timeoutMs` if that wait must be bounded. A watch
   * always ends at a terminal state regardless: a session that cannot change
   * again has nothing left to watch.
   */
  until?: (session: CheckoutSession) => boolean;
  /** How often to re-read beneath the stream, in ms. Default 20000, floor 5000. */
  pollIntervalMs?: number;
  /**
   * Stop watching after this many ms. Reaching it is NOT an outcome and is not
   * an error: the watch simply ends, and the caller reads the status of the
   * snapshot it holds. Unset means watch until `until` holds or the signal
   * aborts.
   */
  timeoutMs?: number;
  /**
   * Called when the live stream drops, is refused, or a re-read fails and the
   * watch carries on without it. Observability only — every one of these is
   * recovered by the layer beneath it, so a caller that does nothing here is
   * correct.
   */
  onDegraded?: (error: unknown) => void;
}

/**
 * Yields each new state of one session until the buyer has nothing left to do
 * (or `until` holds, or the signal aborts, or `timeoutMs` elapses).
 *
 * The first value is always the session as it stands now, so a caller is never
 * left waiting on a transition that already happened. Versions strictly
 * increase: a snapshot at or below the newest one seen is dropped rather than
 * yielded, because it carries nothing new.
 *
 * Throws only what a read of the same session would throw, and only for a
 * failure that waiting cannot fix — an unusable credential, an unknown session.
 * A dropped stream, a refused stream, or a failed re-read is reported to
 * `onDegraded` and recovered, never thrown: the whole point of the layering is
 * that no single connection is load-bearing.
 */
export async function* watchSnapshots(
  source: SessionSource,
  id: string,
  opts: WatchOptions = {},
): AsyncGenerator<CheckoutSession, void, void> {
  const until = opts.until ?? ((session: CheckoutSession) => isBuyerFinal(session.status));
  const pollMs = Math.max(MIN_POLL_INTERVAL_MS, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  // One controller owns everything this watch started, so returning, breaking out
  // of a `for await`, or throwing all end the stream and the poll through the
  // same path.
  const controller = new AbortController();
  const stop = () => controller.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  const deadline = opts.timeoutMs !== undefined ? setTimeout(stop, opts.timeoutMs) : undefined;

  const pending: CheckoutSession[] = [];
  let wake: (() => void) | undefined;
  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  const push = (session: CheckoutSession) => {
    pending.push(session);
    notify();
  };
  controller.signal.addEventListener('abort', notify, { once: true });

  let newest = -1;
  let fatal: unknown;

  try {
    // The first snapshot is an ordinary read, for two reasons. It fails fast and
    // legibly on the failures a caller must see at the call site rather than as a
    // watch that never yields — a bad credential, an unknown session. And it
    // answers immediately for a session that is already finished, without opening
    // a stream for a state that can no longer change.
    const first = await source.read(id, controller.signal);
    newest = first.version;
    yield first;
    if (isTerminal(first.status) || until(first)) return;

    // Two producers, both of which only ever add snapshots to the queue: the
    // stream for promptness, the poll for certainty. Neither can end the watch —
    // that is the consumer's decision below, on the state it actually saw.
    const producers = Promise.all([
      pumpStream(source, id, () => newest, push, controller.signal, opts.onDegraded),
      pumpPoll(source, id, push, controller.signal, pollMs, opts.onDegraded, (err) => {
        fatal = err;
        notify();
      }),
    ]);
    // Nothing awaits this; an ignored rejection would surface as an unhandled one.
    producers.catch(() => {});

    for (;;) {
      while (pending.length > 0) {
        const snapshot = pending.shift()!;
        // States, not deltas: one already superseded tells the caller nothing.
        if (snapshot.version <= newest) continue;
        newest = snapshot.version;
        yield snapshot;
        // Terminal ends the watch whatever `until` says. A session that cannot
        // change again has nothing left to watch, and a caller must never be left
        // spinning on a condition the session can no longer reach.
        if (isTerminal(snapshot.status) || until(snapshot)) return;
      }
      if (fatal !== undefined) throw fatal;
      if (controller.signal.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    opts.signal?.removeEventListener('abort', stop);
    controller.abort();
  }
}

/**
 * Watches until the buyer has nothing left to do, and returns the last session
 * state seen — the shape a script or a backend job wants when it has nothing to
 * do but wait.
 *
 * The returned session is NOT necessarily finished. A `timeoutMs` that elapses,
 * or an aborted signal, returns the newest snapshot as it stood: read its status
 * and treat a live session as live. Deciding otherwise — reading a deadline as a
 * failure — is how an integration cancels an order for a buyer who was charged.
 */
export async function latestSnapshot(
  source: SessionSource,
  id: string,
  opts: WatchOptions = {},
): Promise<CheckoutSession> {
  let latest: CheckoutSession | undefined;
  for await (const snapshot of watchSnapshots(source, id, opts)) latest = snapshot;
  if (!latest) {
    throw new CheckoutConnectionError('the session watch ended before any snapshot arrived');
  }
  return latest;
}

// Holds the live stream, reconnecting for as long as the watch runs.
//
// Every failure here is a degradation and never the end of the watch: the poll
// beneath it resolves the session either way, so this reports and retries rather
// than surfacing anything to the caller.
async function pumpStream(
  source: SessionSource,
  id: string,
  lastVersion: () => number,
  push: (session: CheckoutSession) => void,
  signal: AbortSignal,
  onDegraded: WatchOptions['onDegraded'],
): Promise<void> {
  let backoff = MIN_RECONNECT_MS;
  while (!signal.aborted) {
    try {
      const delivered = await holdStream(source, id, lastVersion(), push, signal);
      // A connection that carried something was healthy, so a reconnect after it
      // starts from the bottom of the backoff rather than from where a series of
      // failures left it.
      if (delivered) backoff = MIN_RECONNECT_MS;
    } catch (err) {
      if (signal.aborted) return;
      onDegraded?.(err);
      if (err instanceof CheckoutError) {
        // The credential cannot hold this stream, and no amount of retrying will
        // change that. The poll answers whether it is expired-with-the-session or
        // wrong; either way this stops trying.
        if (err.status === 401 || err.status === 403 || err.status === 404) return;
        // Refused for capacity. The core said when to come back, so honor it
        // rather than reconnecting into the same refusal.
        if (err.retryAfter !== undefined) backoff = Math.max(backoff, err.retryAfter * 1_000);
      }
    }
    await sleep(jitter(backoff), signal);
    backoff = Math.min(backoff * 2, MAX_RECONNECT_MS);
  }
}

/**
 * Holds one connection until it ends, pushing each snapshot it carries. Reports
 * whether anything arrived, which is what tells a reconnect apart from a retry.
 */
async function holdStream(
  source: SessionSource,
  id: string,
  lastVersion: number,
  push: (session: CheckoutSession) => void,
  parent: AbortSignal,
): Promise<boolean> {
  const connection = new AbortController();
  const signal = AbortSignal.any([parent, connection.signal]);
  // Covers the connect as well as the read: a request that hangs before the
  // response arrives is exactly as stuck as one that goes silent after it.
  let watchdog = setTimeout(() => connection.abort(), STALL_TIMEOUT_MS);
  let delivered = false;
  try {
    const res = await source.openStream(id, lastVersion >= 0 ? lastVersion : undefined, signal);
    if (!res.body) return false;
    const reader = res.body.getReader();
    // Cancel the body on abort as well as relying on the request signal. A read
    // already waiting on the next chunk is the normal state of a healthy stream,
    // and it must end the moment the watch does rather than when the transport
    // gets round to noticing.
    const release = () => void reader.cancel().catch(() => {});
    signal.addEventListener('abort', release, { once: true });
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return delivered;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => connection.abort(), STALL_TIMEOUT_MS);
        buffer += decoder.decode(value, { stream: true });

        // Server-sent events are separated by a blank line. Anything after the
        // last separator is a partial frame and stays buffered for the next
        // chunk — a parser that assumed one frame per chunk would work against a
        // fast local core and drop snapshots on a real mobile network.
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const snapshot = decodeFrame(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          if (snapshot) {
            delivered = true;
            push(snapshot);
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } finally {
      signal.removeEventListener('abort', release);
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Reads one SSE frame into a session, or null when it carries none — a keep-alive
 * comment, or anything unparseable. A malformed frame is skipped rather than
 * thrown: one bad frame must not end a watch someone is waiting on, and the next
 * snapshot supersedes it anyway.
 */
function decodeFrame(frame: string): CheckoutSession | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as CheckoutSession;
    // Guard the one field the watch itself depends on. A frame without a version
    // cannot be ordered against what the caller holds, so it is dropped rather
    // than yielded out of order.
    return typeof parsed?.version === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

// Re-reads the session on the floor interval, for as long as the watch runs.
async function pumpPoll(
  source: SessionSource,
  id: string,
  push: (session: CheckoutSession) => void,
  signal: AbortSignal,
  intervalMs: number,
  onDegraded: WatchOptions['onDegraded'],
  onFatal: (err: unknown) => void,
): Promise<void> {
  while (!signal.aborted) {
    await sleep(intervalMs, signal);
    if (signal.aborted) return;
    try {
      push(await source.read(id, signal));
    } catch (err) {
      if (signal.aborted) return;
      onDegraded?.(err);
      if (err instanceof CheckoutError) {
        // A credential scoped to the session expires with it, so losing the right
        // to read partway through is an ordinary end to a watch, not a fault. The
        // caller keeps the last snapshot it was given.
        if (err.status === 401 || err.status === 403) return;
        // A session the core will not read for us at all is not something the
        // next tick recovers, and a watch that silently never resolves is worse
        // than an error at the call site.
        if (err.status === 404 || err.status === 400) {
          onFatal(err);
          return;
        }
      }
      // Everything else — a refusal for rate, a 5xx, an unreachable core — is
      // transient by construction. The next tick retries, and a failed read is
      // never an outcome.
    }
  }
}

// Adds up to a quarter of the delay, so watchers that were displaced together do
// not reconnect together.
function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * (ms / 4));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
