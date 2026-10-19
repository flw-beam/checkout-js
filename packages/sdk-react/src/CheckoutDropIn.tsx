'use client';

// The drop-in as a React component.
//
// A thin wrapper over @flutterwavebnw/checkout-runtime, which fetches the checkout runtime
// from the checkout origin — that is where every decision actually lives: the
// frame, the protocol, the credential handshake. This exists because a React
// merchant should not have to hold a ref, load a script into it on an effect,
// and remember to destroy on unmount; getting that wrong under StrictMode's
// double-invoke leaves two frames racing for one session.
//
// The component holds no payment logic and no credential of its own: it takes
// the session the merchant's server created and passes it through.
import { useEffect, useRef } from 'react';
import { loadCheckout, type PublicSessionState, type SessionCredentials } from '@flutterwavebnw/checkout-runtime';

interface CheckoutDropInCommonProps {
  /**
   * The checkout origin to load the runtime from, and the origin the drop-in
   * will frame. Required: it names the environment you integrate against, so it
   * is never filled in for you.
   */
  origin: string;
  /**
   * Called on every status change.
   *
   * **A UI signal, not proof of payment.** Move your interface along with it;
   * fulfil the order from the signed `payment.succeeded` event your server
   * receives. This one comes from a browser, and a browser can be made to say
   * anything.
   */
  onSession?: (session: PublicSessionState) => void;
  /** The buyer's bank was opened for authentication; `blocked` means in this tab. */
  onStepUp?: (info: { blocked: boolean }) => void;
  /** The frame never answered — usually a blocked frame or a framing policy. */
  onTimeout?: () => void;
  /**
   * No frame was ever created: the checkout runtime could not be loaded — a
   * blocked script, an offline buyer, or a wrong `origin` — or `fetchSession`
   * failed. Distinct from `onTimeout`, which is a frame that exists and stayed
   * silent. Handle it: this is the case where the container simply stays empty,
   * and the buyer has no way to tell that from a slow page.
   */
  onError?: (error: Error) => void;
  /**
   * The frame can no longer show the session, because its `client_secret` no
   * longer reads it. A session that ended while the buyer was away is not this:
   * the frame shows how it ended and calls `onSession`. This is a session past
   * the short window after its expiry time, or one whose expiry time passed
   * before it finished. **Not a failure** — the buyer may have paid. Ask your
   * server, which reads the session with your API key, and mount a new checkout
   * only if it failed, expired, was canceled or was abandoned.
   */
  onClosed?: (info: { sessionId: string }) => void;
  /** Accessible name for the frame. Defaults to "Checkout". */
  title?: string;
  /** Applied to the element the frame is mounted into, for layout. */
  className?: string;
}

/** A session your page already holds. */
interface WithSessionProps extends CheckoutDropInCommonProps {
  /** The session to drive, created by your server with your API key. */
  sessionId: string;
  /** That session's `client_secret`, as returned to the server that created it. */
  clientSecret: string;
  fetchSession?: never;
  reuseKey?: never;
}

/** A session the drop-in asks your server for once it mounts. */
interface WithFetchProps extends CheckoutDropInCommonProps {
  /**
   * Ask your server for the session and resolve with its id and `client_secret`.
   * Called when the drop-in mounts and has no session to reuse — so the page
   * renders the component straight away rather than fetching first and rendering
   * once the session is back.
   */
  fetchSession: () => Promise<SessionCredentials>;
  /**
   * What this checkout is paying for — an order id, or a cart id that changes
   * when the cart does. Remounting with the same key in the same tab reopens the
   * session already fetched for it, until that session ends. Pass one: without
   * it every mount fetches, and StrictMode mounts twice in development.
   */
  reuseKey?: string;
  sessionId?: never;
  clientSecret?: never;
}

export type CheckoutDropInProps = WithSessionProps | WithFetchProps;

export function CheckoutDropIn({
  sessionId,
  clientSecret,
  fetchSession,
  reuseKey,
  origin,
  onSession,
  onStepUp,
  onTimeout,
  onError,
  onClosed,
  title,
  className,
}: CheckoutDropInProps) {
  const container = useRef<HTMLDivElement>(null);

  // The callbacks are read through a ref so a parent that passes inline
  // functions — which is most of them — does not remount the frame on every
  // render. Remounting a checkout mid-payment would drop the buyer back to a
  // blank frame and re-run the credential handshake for a session already in
  // flight.
  //
  // `fetchSession` too, for the same reason: it is almost always an inline
  // function, and a new one every render is not a new purchase. Whether the
  // session is fetched at all is part of the identity; which function fetches it
  // is not.
  const handlers = useRef({ onSession, onStepUp, onTimeout, onError, onClosed, fetchSession });
  handlers.current = { onSession, onStepUp, onTimeout, onError, onClosed, fetchSession };
  const fetching = fetchSession !== undefined;

  useEffect(() => {
    const node = container.current;
    if (!node) return;

    // The load is asynchronous now, so this effect can be torn down before the
    // runtime arrives — StrictMode's double-invoke does exactly that on every
    // mount in development. Both branches below are needed: one stops a frame
    // being created for an effect that is already over, the other destroys one
    // that won the race by a tick.
    let cancelled = false;
    let mounted: { destroy(): void } | null = null;

    void loadCheckout({ origin })
      .then((checkout) => {
        if (cancelled) return;
        const common = {
          container: node,
          ...(title !== undefined ? { title } : {}),
          onSession: (session: PublicSessionState) => handlers.current.onSession?.(session),
          onStepUp: (info: { blocked: boolean }) => handlers.current.onStepUp?.(info),
          onTimeout: () => handlers.current.onTimeout?.(),
          onError: (error: Error) => handlers.current.onError?.(error),
          onClosed: (info: { sessionId: string }) => handlers.current.onClosed?.(info),
        };
        mounted = checkout.mount(
          fetching
            ? {
                ...common,
                fetchSession: () => {
                  const fetch = handlers.current.fetchSession;
                  if (!fetch) return Promise.reject(new Error('FlutterwavebnwCheckout: fetchSession was removed'));
                  return fetch();
                },
                ...(reuseKey !== undefined ? { reuseKey } : {}),
              }
            : { ...common, sessionId: sessionId as string, clientSecret: clientSecret as string },
        );
        if (cancelled) {
          mounted.destroy();
          mounted = null;
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        handlers.current.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

    return () => {
      cancelled = true;
      mounted?.destroy();
      mounted = null;
    };
    // The session is the identity of the mounted checkout. Anything else
    // changing must not tear down a payment in progress.
  }, [sessionId, clientSecret, fetching, reuseKey, origin, title]);

  return <div ref={container} className={className} />;
}
