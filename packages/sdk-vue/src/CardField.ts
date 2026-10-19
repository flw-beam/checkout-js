// The inline card field as a Vue component.
//
// This is the other half of building your own checkout. `useCheckoutSession`
// drives the session — the totals, the methods, the authorize — and this puts
// the one input you cannot own where you want it: the card is typed inside a
// frame on the checkout origin and posted straight to the vault, so your page
// never holds a card number and your site never enters the cardholder data
// environment.
//
// The field's verbs are exposed on the component, so a template ref is the
// handle: on your own submit you call `capture()`, get a token back, and pass it
// to `selectMethod` with your session. Nothing here holds a credential of its own
// or knows any payment logic.
import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue';
import {
  loadCheckout,
  type CapturedCard,
  type CardField as CardFieldHandle,
  type CardFieldAppearance,
  type CardFieldState,
} from '@flutterwavebnw/checkout-runtime';

/**
 * What a template ref to `<CardField>` can call. The same verbs the runtime's
 * field has, reached through the component so they always address the frame
 * that is on the page now rather than one a remount already replaced.
 */
export interface CardFieldExposed {
  /**
   * Tokenize what the buyer typed. Resolves with the vault's token, which you
   * pass to `selectMethod` as `{ method: 'card', token, display, issuer }`.
   * Rejects with an error carrying a `code` when the entry is incomplete, the
   * vault refuses it, or there is no field on the page to capture from.
   */
  capture(): Promise<CapturedCard>;
  /** Put the cursor in the field — for restoring focus after an error. */
  focus(): void;
  /** Empty the field, after a decline the buyer should retype through. */
  clear(): void;
}

// The runtime's own codes for a capture with no field behind it, so a merchant
// branching on `code` handles one vocabulary whichever wrapper they use.
function noField(code: 'field_unreachable' | 'field_destroyed', message: string): Error {
  return Object.assign(new Error(message), { code });
}

export const CardField = defineComponent({
  name: 'CardField',
  props: {
    /** The session this card will be captured for, created by your server. */
    sessionId: { type: String, required: true },
    /** That session's `client_secret`. Handed to the frame in a message, never a URL. */
    clientSecret: { type: String, required: true },
    /**
     * The checkout origin to load the runtime from, and the origin the field is
     * framed from. Required: it names the environment you integrate against, so
     * it is never filled in for you.
     */
    origin: { type: String, required: true },
    /** Bind the field to your own design tokens. */
    appearance: { type: Object as PropType<CardFieldAppearance | undefined>, default: undefined },
    /** Locale for the field's placeholders and accessible labels. */
    locale: { type: String as PropType<string | undefined>, default: undefined },
    /** Accessible name for the frame. Defaults to "Card details". */
    title: { type: String as PropType<string | undefined>, default: undefined },
  },
  emits: {
    /** Every change to the entry: empty, complete, and why not. */
    change: (_state: CardFieldState) => true,
    /** The field is mounted and ready to accept a card. */
    ready: () => true,
    /**
     * A card cannot be collected at all — offer another method. The alternative
     * is a buyer typing a card into an input that was never going to submit it.
     */
    unavailable: (_info: { code: string; message: string }) => true,
    /** The field never answered — usually a framing policy on your page. */
    timeout: () => true,
    /**
     * The runtime could not be loaded, so no field was ever created — a blocked
     * script, an offline buyer, or a wrong `origin`. Distinct from `timeout`,
     * which is a frame that exists and stayed silent. Handle it: this is the case
     * where the box simply stays empty and the buyer cannot tell that from a slow
     * page.
     */
    error: (_error: Error) => true,
  },
  setup(props, { emit, expose }) {
    const container = ref<HTMLDivElement | null>(null);
    let field: CardFieldHandle | null = null;
    let teardown: (() => void) | null = null;
    // Whether a field has ever been on the page, so a capture after it went away
    // is told that rather than being told it never loaded.
    let hadField = false;

    function mount(): void {
      teardown?.();
      const node = container.value;
      if (!node) return;

      // The load is asynchronous, so the component can be unmounted — or the
      // session swapped — before the runtime arrives. Both branches are needed:
      // one stops a field being created for a mount that is already over, the
      // other destroys one that won the race by a tick.
      let cancelled = false;
      teardown = () => {
        cancelled = true;
        field?.destroy();
        field = null;
      };

      const { sessionId, clientSecret, origin, locale, title } = props;
      void loadCheckout({ origin })
        .then((checkout) => {
          if (cancelled) return;
          const mounted = checkout.mountCardField({
            sessionId,
            clientSecret,
            container: node,
            // Read at mount time rather than tracked: a later change is applied to
            // the live field below instead of remounting it.
            ...(props.appearance !== undefined ? { appearance: props.appearance } : {}),
            ...(locale !== undefined ? { locale } : {}),
            ...(title !== undefined ? { title } : {}),
            onChange: (state) => emit('change', state),
            onReady: () => emit('ready'),
            onUnavailable: (info) => emit('unavailable', info),
            onTimeout: () => emit('timeout'),
          });
          if (cancelled) {
            mounted.destroy();
            return;
          }
          field = mounted;
          hadField = true;
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          emit('error', error instanceof Error ? error : new Error(String(error)));
        });
    }

    onMounted(mount);
    // The session is the identity of the mounted field. Anything else changing
    // must not empty an entry the buyer is in the middle of.
    watch(() => [props.sessionId, props.clientSecret, props.origin, props.locale, props.title], mount);
    // Appearance is applied through the mounted field rather than by remounting,
    // for the same reason: a merchant switching to a dark theme mid-checkout must
    // not cost the buyer what they have typed.
    watch(
      () => props.appearance,
      (appearance) => {
        if (appearance) field?.setAppearance(appearance);
      },
      { deep: true },
    );
    onBeforeUnmount(() => {
      teardown?.();
      teardown = null;
    });

    const exposed: CardFieldExposed = {
      capture: () =>
        field
          ? field.capture()
          : Promise.reject(
              hadField
                ? noField('field_destroyed', 'The card field is no longer on the page.')
                : noField('field_unreachable', 'The card field did not load.'),
            ),
      focus: () => field?.focus(),
      clear: () => field?.clear(),
    };
    expose(exposed);

    // `class` and `style` fall through to this element, for layout.
    return () => h('div', { ref: container });
  },
});
