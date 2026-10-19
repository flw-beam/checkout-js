// The loader — the only thing this package does at run time.
//
// What is worth proving is narrow, because the package is: that it fetches the
// runtime from the origin it was told and no other, that a page cannot be made
// to load it twice, and that every way the fetch can fail produces an error a
// merchant can act on rather than a promise nobody settles. That last one is the
// real hazard here: a loader that hangs shows the buyer an empty container with
// nothing in the console, which is indistinguishable from a checkout that is
// merely slow.
//
// Driven under jsdom rather than a stub document, because what is being asserted
// is the script tag that ends up in a real DOM and the events a real script
// element emits.
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { JSDOM } from 'jsdom';

const CHECKOUT_ORIGIN = 'https://checkout.test';
const RUNTIME_SRC = `${CHECKOUT_ORIGIN}/v1/checkout.js`;

let dom: JSDOM;
let loadCheckout: typeof import('../src/loader.js').loadCheckout;

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://shop.example/cart',
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;

  // A fresh module per test, because the loader caches resolved runtimes by
  // origin for the lifetime of the page — which is correct in a browser and
  // would otherwise leak one test's outcome into the next.
  const fresh = `../src/loader.js?t=${Math.random()}`;
  ({ loadCheckout } = (await import(fresh)) as typeof import('../src/loader.js'));
});

afterEach(() => {
  dom.window.close();
});

/** The script tag the loader added, if it added one. */
function tag(): HTMLScriptElement | null {
  return dom.window.document.querySelector('script[src]');
}

/** A stand-in for what the real bundle assigns to `window`. */
function fakeRuntime() {
  return { mount: () => ({ destroy() {}, frame: null as never }), protocolVersion: 1 };
}

/** Behaves as the browser does when the script arrives and runs. */
function scriptSucceeds(runtime = fakeRuntime()) {
  const script = tag();
  assert.ok(script, 'no script tag was added');
  (dom.window as unknown as { FlutterwavebnwCheckout?: unknown }).FlutterwavebnwCheckout = runtime;
  script.dispatchEvent(new dom.window.Event('load'));
  return runtime;
}

test('the runtime is fetched from the configured origin, and resolved', async () => {
  const pending = loadCheckout({ origin: CHECKOUT_ORIGIN });

  const script = tag();
  assert.ok(script);
  assert.equal(script.src, RUNTIME_SRC);
  assert.equal(script.async, true);

  const runtime = scriptSucceeds();
  assert.equal(await pending, runtime);
});

// The origin decides where a live payment credential is posted, so a stray path
// or trailing slash must reduce rather than produce a script URL that 404s.
test('the checkout address is reduced to a bare origin', async () => {
  const pending = loadCheckout({ origin: 'https://checkout.test/some/path/' });
  assert.equal(tag()?.src, RUNTIME_SRC);
  scriptSucceeds();
  await pending;
});

test('an unusable checkout address is refused rather than half-applied', () => {
  assert.throws(() => loadCheckout({ origin: 'not a url' }), /valid checkout origin/);
  assert.throws(() => loadCheckout({ origin: 'javascript:alert(1)' }), /must be http/);
});

// The origin names where a live session credential is sent, so it is never filled
// in on the caller's behalf: leaving it out is a refusal at the call, not a script
// fetched from whichever deployment a default named. A plain-JavaScript caller can
// still call this with nothing, so the refusal is asserted at run time too.
test('a missing checkout origin is refused rather than defaulted', () => {
  const load = loadCheckout as (options?: unknown) => Promise<unknown>;
  for (const options of [undefined, {}, { origin: '' }, { origin: '   ' }]) {
    assert.throws(() => load(options), /no checkout origin was given/, JSON.stringify(options));
  }
  assert.equal(tag(), null, 'a refused load adds no script tag');
});

// Two components mounting on the same render is the ordinary case, and two
// script tags for the same file is a wasted request at best and a second runtime
// racing the first at worst.
test('concurrent loads for one origin share a single script tag', async () => {
  const a = loadCheckout({ origin: CHECKOUT_ORIGIN });
  const b = loadCheckout({ origin: CHECKOUT_ORIGIN });

  assert.equal(dom.window.document.querySelectorAll('script[src]').length, 1);

  const runtime = scriptSucceeds();
  assert.equal(await a, runtime);
  assert.equal(await b, runtime);
});

test('a page that already has the runtime resolves without a network request', async () => {
  const runtime = fakeRuntime();
  (dom.window as unknown as { FlutterwavebnwCheckout?: unknown }).FlutterwavebnwCheckout = runtime;

  assert.equal(await loadCheckout({ origin: CHECKOUT_ORIGIN }), runtime);
  assert.equal(tag(), null, 'a script tag was added for a runtime already present');
});

// A merchant who writes the script tag by hand and also uses the React
// component gets both paths on one page. The hand-written tag is the one that
// should win.
test('an existing script tag for the same runtime is reused, not duplicated', async () => {
  const manual = dom.window.document.createElement('script');
  manual.src = RUNTIME_SRC;
  dom.window.document.head.appendChild(manual);

  const pending = loadCheckout({ origin: CHECKOUT_ORIGIN });
  assert.equal(dom.window.document.querySelectorAll('script[src]').length, 1);

  const runtime = scriptSucceeds();
  assert.equal(await pending, runtime);
});

test('a runtime that fails to load rejects with the address that failed', async () => {
  const pending = loadCheckout({ origin: CHECKOUT_ORIGIN });
  tag()?.dispatchEvent(new dom.window.Event('error'));

  await assert.rejects(pending, /could not load the checkout runtime from https:\/\/checkout\.test/);
});

// A captive portal or a proxy serving an error page with a 200 looks exactly
// like this: the browser reports a successful load and no runtime appears.
test('a script that loads but defines nothing rejects rather than resolving empty', async () => {
  const pending = loadCheckout({ origin: CHECKOUT_ORIGIN });
  tag()?.dispatchEvent(new dom.window.Event('load'));

  await assert.rejects(pending, /loaded but defined no checkout runtime/);
});

// A failed load must not poison the origin forever: the merchant has no way to
// clear this cache, and one flaky moment would otherwise cost every payment for
// the life of the page.
test('a failed load can be retried', async () => {
  const failed = loadCheckout({ origin: CHECKOUT_ORIGIN });
  tag()?.dispatchEvent(new dom.window.Event('error'));
  await assert.rejects(failed);

  dom.window.document.head.innerHTML = '';
  const retried = loadCheckout({ origin: CHECKOUT_ORIGIN });
  const runtime = scriptSucceeds();
  assert.equal(await retried, runtime);
});

// A merchant testing a sandbox deployment beside production is the ordinary
// reason two would be on one page, and the cache must not hand one of them the
// other's runtime.
test('two origins load independently', async () => {
  const other = 'https://checkout.sandbox.test';
  const a = loadCheckout({ origin: CHECKOUT_ORIGIN });
  const b = loadCheckout({ origin: other });

  const scripts = Array.from(dom.window.document.querySelectorAll('script[src]'));
  assert.deepEqual(
    scripts.map((s) => (s as HTMLScriptElement).src).sort(),
    [`${CHECKOUT_ORIGIN}/v1/checkout.js`, `${other}/v1/checkout.js`].sort(),
  );

  const runtime = fakeRuntime();
  (dom.window as unknown as { FlutterwavebnwCheckout?: unknown }).FlutterwavebnwCheckout = runtime;
  for (const script of scripts) script.dispatchEvent(new dom.window.Event('load'));

  assert.equal(await a, runtime);
  assert.equal(await b, runtime);
});
