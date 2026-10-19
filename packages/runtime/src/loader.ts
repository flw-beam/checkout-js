/**
 * Fetches the checkout runtime and hands it back.
 *
 * This is the whole of what this package does at run time: add a `<script>` tag
 * pointing at the checkout origin, wait for it, and resolve the global it
 * defines. There is no protocol here, no frame, no credential handling — all of
 * that is in the script being fetched, served from the same deployment as the
 * checkout document it will frame.
 *
 * The split is not stylistic. The host half decides where a live payment
 * credential gets posted, and a copy of that decision compiled into a merchant's
 * application is a copy we cannot fix. Served, it is corrected for every
 * integration at once; bundled, it is corrected for whoever redeploys. This file
 * is the part that is safe to freeze on a merchant's disk precisely because it
 * knows nothing worth patching.
 */
import type { FlutterwavebnwCheckout, LoadOptions } from './types.js';

/**
 * Where the runtime lives on the checkout origin.
 *
 * A second copy of a string the checkout app also holds, and necessarily so:
 * this is the published address of the seam between the two, the same way a
 * hand-written `<script src>` in a merchant's HTML is a third copy. It is
 * therefore append-only — the file behind it is replaced in place, and a new
 * path would strand every page already pointing at this one.
 */
const RUNTIME_PATH = '/v1/checkout.js';

const DEFAULT_LOAD_TIMEOUT_MS = 20_000;

/**
 * In-flight and settled loads, by origin.
 *
 * Keyed rather than a single slot because a page can legitimately drive two
 * deployments at once — a merchant testing against a sandbox beside production
 * is the ordinary case — and because two components mounting on the same render
 * must not race two script tags for the same origin. A rejected load is evicted
 * so a retry can actually retry; a resolved one is kept forever, which is
 * correct because the runtime is a singleton on `window` regardless.
 */
const loads = new Map<string, Promise<FlutterwavebnwCheckout>>();

/**
 * Loads the checkout runtime, then use `mount` on what it resolves.
 *
 * Safe to call as often as you like: concurrent calls for the same origin share
 * one script tag, and a page that already has the runtime — because a `<script>`
 * tag loaded it, or because something else called this first — resolves without
 * touching the network.
 *
 * The checkout origin is required; there is no default to fall back on.
 */
export function loadCheckout(options: LoadOptions): Promise<FlutterwavebnwCheckout> {
  const origin = normalizeOrigin(requireOrigin(options));

  const existing = loads.get(origin);
  if (existing) return existing;

  const load = injectAndWait(origin).catch((error: unknown) => {
    // Evicted on failure so a caller can retry — a checkout that gave up
    // permanently because of one flaky network moment is a lost payment, and the
    // merchant has no way to clear this cache themselves.
    loads.delete(origin);
    throw error;
  });
  loads.set(origin, load);
  return load;
}

function injectAndWait(origin: string): Promise<FlutterwavebnwCheckout> {
  // Server-rendered: there is nothing to attach a script to, and no buyer. Said
  // plainly, because the alternative is a `document is not defined` from inside
  // a payment library, which sends people looking in the wrong place.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(
      new Error('FlutterwavebnwCheckout: the checkout runtime can only be loaded in a browser'),
    );
  }

  const ready = window.FlutterwavebnwCheckout;
  if (ready) return Promise.resolve(ready);

  const src = origin + RUNTIME_PATH;

  return new Promise<FlutterwavebnwCheckout>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const onLoad = () => {
      const runtime = window.FlutterwavebnwCheckout;
      // The script ran and left no runtime behind. This is what a proxy serving
      // an error page with a 200, or a captive portal, looks like from here —
      // and it is worth naming, because the browser reports it as a successful
      // load and the merchant would otherwise see only a checkout that never
      // appeared.
      finish(() =>
        runtime
          ? resolve(runtime)
          : reject(new Error(`FlutterwavebnwCheckout: ${src} loaded but defined no checkout runtime`)),
      );
    };
    const onError = () =>
      finish(() => reject(new Error(`FlutterwavebnwCheckout: could not load the checkout runtime from ${src}`)));

    // A tag for this exact script may already be on the page — a merchant who
    // writes the script tag by hand *and* uses a component that calls this, most
    // often. Reuse it rather than fetching the same file twice.
    const existingTag = document.querySelector<HTMLScriptElement>(
      `script[src="${cssEscape(src)}"]`,
    );
    const script = existingTag ?? document.createElement('script');

    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);

    // The timer covers the one case the events cannot: a tag that finished
    // loading before this call attached to it, whose `load` has already fired
    // and will not fire again. Without it that resolves to a promise nobody ever
    // settles, and the buyer waits at an empty container with no error anywhere.
    const timer = setTimeout(() => {
      const runtime = window.FlutterwavebnwCheckout;
      finish(() =>
        runtime
          ? resolve(runtime)
          : reject(new Error(`FlutterwavebnwCheckout: timed out loading the checkout runtime from ${src}`)),
      );
    }, DEFAULT_LOAD_TIMEOUT_MS);

    if (!existingTag) {
      script.src = src;
      script.async = true;
      (document.head ?? document.body ?? document.documentElement).appendChild(script);
    }
  });
}

/**
 * The checkout origin the caller chose, or a refusal when they chose none.
 *
 * There is deliberately no default. This address is where the runtime frames
 * checkout and posts the session credential, so a value nobody chose sends that
 * credential to whichever deployment a default happened to name: a checkout that
 * never loads at best, a live session handed to the wrong environment at worst.
 * Checked at run time as well as by the type, because a plain-JavaScript caller
 * can still call this with nothing.
 */
function requireOrigin(options: LoadOptions | undefined): string {
  const origin = options?.origin;
  if (typeof origin !== 'string' || origin.trim() === '') {
    throw new Error(
      'FlutterwavebnwCheckout: no checkout origin was given; call loadCheckout({ origin }) with the checkout origin of the environment you are integrating against',
    );
  }
  return origin;
}

/**
 * Reduces the configured checkout address to a bare origin.
 *
 * This becomes the script's address, and through it the origin the runtime will
 * frame and post the session credential to, so it has to be exactly what the
 * browser will report. A trailing slash or a stray path would produce a script
 * URL that 404s, or an origin comparison that never matches — and the drop-in
 * would sit at its placeholder height forever with nothing to explain why.
 */
function normalizeOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`FlutterwavebnwCheckout: "${raw}" is not a valid checkout origin`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`FlutterwavebnwCheckout: the checkout origin must be http(s), got "${parsed.protocol}"`);
  }
  return parsed.origin;
}

/**
 * Escapes a URL for use inside a CSS attribute selector.
 *
 * The value is one we built from a parsed origin plus a constant path, so it
 * cannot carry a quote today. It is escaped anyway because the day someone
 * widens what `origin` accepts, a selector is the last place that should decide
 * what happens next.
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
