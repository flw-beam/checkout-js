'use client';

// The inline card field as a React component.
//
// This is the other half of building your own checkout. `useCheckoutSession`
// drives the session — the totals, the methods, the authorize — and this puts
// the one input you cannot own where you want it: the card is typed inside a
// frame on the checkout origin and posted straight to the vault, so your page
// never holds a card number and your site never enters the cardholder data
// environment.
//
// The component gives you the field's handle through `onField`, because the
// interesting moment is your own submit: you call `capture()`, get a token back,
// and pass it to `select_method` with your session client. Nothing here holds a
// credential of its own or knows any payment logic.
import { useEffect, useRef } from 'react';
import {
  loadCheckout,
  type CardField as CardFieldHandle,
  type CardFieldAppearance,
  type CardFieldState,
} from '@flutterwavebnw/checkout-runtime';

export interface CardFieldProps {
  /** The session this card will be captured for, created by your server. */
  sessionId: string;
  /** That session's `client_secret`. Handed to the frame in a message, never a URL. */
  clientSecret: string;
  /**
   * The checkout origin to load the runtime from, and the origin the field is
   * framed from. Required: it names the environment you integrate against, so
   * it is never filled in for you.
   */
  origin: string;
  /** Bind the field to your own design tokens. */
  appearance?: CardFieldAppearance;
  /** Locale for the field's placeholders and accessible labels. */
  locale?: string;
  /**
   * The mounted field, as soon as it exists — and null when it goes away, so a
   * ref you keep cannot outlive the frame it points at. This is what you call
   * `capture()` on when the buyer submits.
   */
  onField?: (field: CardFieldHandle | null) => void;
  /** Called on every change to the entry: empty, complete, and why not. */
  onChange?: (state: CardFieldState) => void;
  /** The field is mounted and ready to accept a card. */
  onReady?: () => void;
  /**
   * A card cannot be collected at all — offer another method. The alternative is
   * a buyer typing a card into an input that was never going to submit it.
   */
  onUnavailable?: (info: { code: string; message: string }) => void;
  /** The field never answered — usually a framing policy on your page. */
  onTimeout?: () => void;
  /**
   * The runtime could not be loaded, so no field was ever created — a blocked
   * script, an offline buyer, or a wrong `origin`. Distinct from `onTimeout`,
   * which is a frame that exists and stayed silent. Handle it: this is the case
   * where the box simply stays empty and the buyer cannot tell that from a slow
   * page.
   */
  onError?: (error: Error) => void;
  /** Accessible name for the frame. Defaults to "Card details". */
  title?: string;
  /** Applied to the element the frame is mounted into, for layout. */
  className?: string;
}

export function CardField({
  sessionId,
  clientSecret,
  origin,
  appearance,
  locale,
  onField,
  onChange,
  onReady,
  onUnavailable,
  onTimeout,
  onError,
  title,
  className,
}: CardFieldProps) {
  const container = useRef<HTMLDivElement>(null);

  // Read through a ref so a parent passing inline functions — which is most of
  // them — does not remount the field on every render. Remounting mid-entry
  // would empty a card the buyer had already typed.
  const handlers = useRef({ onField, onChange, onReady, onUnavailable, onTimeout, onError });
  handlers.current = { onField, onChange, onReady, onUnavailable, onTimeout, onError };

  // Appearance is applied through the mounted field rather than by remounting,
  // for the same reason: a merchant switching to a dark theme mid-checkout must
  // not cost the buyer what they have typed.
  const field = useRef<CardFieldHandle | null>(null);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;

  useEffect(() => {
    const node = container.current;
    if (!node) return;

    // The load is asynchronous, so this effect can be torn down before the
    // runtime arrives — StrictMode's double-invoke does exactly that on every
    // mount in development. Both branches are needed: one stops a field being
    // created for an effect that is already over, the other destroys one that
    // won the race by a tick.
    let cancelled = false;

    void loadCheckout({ origin })
      .then((checkout) => {
        if (cancelled) return;
        const mounted = checkout.mountCardField({
          sessionId,
          clientSecret,
          container: node,
          ...(appearanceRef.current !== undefined ? { appearance: appearanceRef.current } : {}),
          ...(locale !== undefined ? { locale } : {}),
          ...(title !== undefined ? { title } : {}),
          onChange: (state) => handlers.current.onChange?.(state),
          onReady: () => handlers.current.onReady?.(),
          onUnavailable: (info) => handlers.current.onUnavailable?.(info),
          onTimeout: () => handlers.current.onTimeout?.(),
        });
        if (cancelled) {
          mounted.destroy();
          return;
        }
        field.current = mounted;
        handlers.current.onField?.(mounted);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        handlers.current.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

    return () => {
      cancelled = true;
      field.current?.destroy();
      field.current = null;
      // Told plainly rather than left dangling: a parent holding the handle
      // would otherwise call `capture()` on a frame that is no longer there and
      // get a rejection it has no way to explain.
      handlers.current.onField?.(null);
    };
    // The session is the identity of the mounted field. Anything else changing
    // must not empty an entry the buyer is in the middle of.
  }, [sessionId, clientSecret, origin, locale, title]);

  useEffect(() => {
    if (appearance) field.current?.setAppearance(appearance);
  }, [appearance]);

  return <div ref={container} className={className} />;
}
