// The drop-in as a Vue component.
//
// A thin wrapper over @flutterwavebnw/checkout-runtime, which fetches the checkout runtime
// from the checkout origin — that is where every decision actually lives: the
// frame, the protocol, the credential handshake. This exists because a Vue
// merchant should not have to hold a template ref, load a script once it is
// mounted, and remember to destroy the frame on unmount; getting the ordering
// wrong leaves either no frame or two racing for one session.
//
// The component holds no payment logic and no credential of its own: it takes
// the session the merchant's server created and passes it through. It mounts only
// in the browser, from `onMounted`, so a server render (Nuxt) produces the empty
// container and nothing else.
import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue';
import { loadCheckout, type MountOptions, type PublicSessionState, type SessionCredentials } from '@flutterwavebnw/checkout-runtime';

export const CheckoutDropIn = defineComponent({
  name: 'CheckoutDropIn',
  // Two shapes, as `mount` takes them: a session the page already holds
  // (`session-id` and `client-secret`), or one the drop-in asks your server for
  // (`fetch-session`). Vue props cannot say "one or the other", so the runtime
  // says it instead, and a shape that is neither or both arrives as `error`.
  props: {
    /** The session to drive, created by your server with your API key. */
    sessionId: { type: String as PropType<string | undefined>, default: undefined },
    /** That session's `client_secret`, as returned to the server that created it. */
    clientSecret: { type: String as PropType<string | undefined>, default: undefined },
    /**
     * Ask your server for the session and resolve with its id and
     * `client_secret`. Called when the drop-in mounts and has no session to
     * reuse, so the page renders the component straight away rather than
     * fetching first and rendering once the session is back.
     */
    fetchSession: {
      type: Function as PropType<(() => Promise<SessionCredentials>) | undefined>,
      default: undefined,
    },
    /**
     * What this checkout is paying for — an order id, or a cart id that changes
     * when the cart does. Remounting with the same key in the same tab reopens
     * the session already fetched for it, until that session ends. Without it,
     * every mount fetches.
     */
    reuseKey: { type: String as PropType<string | undefined>, default: undefined },
    /**
     * The checkout origin to load the runtime from, and the origin the drop-in
     * will frame. Required: it names the environment you integrate against, so
     * it is never filled in for you.
     */
    origin: { type: String, required: true },
    /** Accessible name for the frame. Defaults to "Checkout". */
    title: { type: String as PropType<string | undefined>, default: undefined },
  },
  emits: {
    /**
     * Every status change. **A UI signal, not proof of payment.** Move your
     * interface along with it; fulfil the order from the signed
     * `payment.succeeded` event your server receives. This one comes from a
     * browser, and a browser can be made to say anything.
     */
    session: (_session: PublicSessionState) => true,
    /** The buyer's bank was opened for authentication; `blocked` means in this tab. */
    'step-up': (_info: { blocked: boolean }) => true,
    /** The frame never answered — usually a blocked frame or a framing policy. */
    timeout: () => true,
    /**
     * No frame was ever created: the checkout runtime could not be loaded — a
     * blocked script, an offline buyer, or a wrong `origin` — or `fetch-session`
     * failed. Distinct from `timeout`, which is a frame that exists and stayed
     * silent. Handle it: this is the case where the container simply stays
     * empty, and the buyer has no way to tell that from a slow page.
     */
    error: (_error: Error) => true,
    /**
     * The frame can no longer show the session, because its `client_secret` no
     * longer reads it. A session that ended while the buyer was away is not
     * this: the frame shows how it ended and emits `session`. This is a session
     * past the short window after its expiry time, or one whose expiry time
     * passed before it finished. **Not a failure** — the buyer may have paid.
     * Ask your server, which reads the session with your API key, and mount a
     * new checkout only if it failed, expired, was canceled or was abandoned.
     */
    closed: (_info: { sessionId: string }) => true,
  },
  setup(props, { emit }) {
    const container = ref<HTMLDivElement | null>(null);
    let teardown: (() => void) | null = null;

    function mount(): void {
      teardown?.();
      const node = container.value;
      if (!node) return;

      // The load is asynchronous, so the component can be unmounted — or the
      // session swapped — before the runtime arrives. Both branches below are
      // needed: one stops a frame being created for a mount that is already
      // over, the other destroys one that won the race by a tick.
      let cancelled = false;
      let mounted: { destroy(): void } | null = null;
      teardown = () => {
        cancelled = true;
        mounted?.destroy();
        mounted = null;
      };

      const { sessionId, clientSecret, reuseKey, origin, title } = props;
      const fetching = props.fetchSession !== undefined;
      void loadCheckout({ origin })
        .then((checkout) => {
          if (cancelled) return;
          const common = {
            container: node,
            ...(title !== undefined ? { title } : {}),
            onSession: (session: PublicSessionState) => emit('session', session),
            onStepUp: (info: { blocked: boolean }) => emit('step-up', info),
            onTimeout: () => emit('timeout'),
            onError: (error: Error) => emit('error', error),
            onClosed: (info: { sessionId: string }) => emit('closed', info),
          };
          // Whatever is passed along here the runtime checks, so a half-given
          // shape is refused there with a message naming the fix, and lands in
          // the catch below as `error`.
          const options = fetching
            ? {
                ...common,
                // Read at call time rather than captured, so a parent that passes
                // a new function is heard without remounting a payment.
                fetchSession: () => props.fetchSession!(),
                ...(reuseKey !== undefined ? { reuseKey } : {}),
              }
            : { ...common, sessionId, clientSecret };
          mounted = checkout.mount(options as MountOptions);
          if (cancelled) {
            mounted.destroy();
            mounted = null;
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          emit('error', error instanceof Error ? error : new Error(String(error)));
        });
    }

    onMounted(mount);
    // The session is the identity of the mounted checkout. Anything else
    // changing — a listener, a class, which function fetches the session — must
    // not tear down a payment in progress, which is why only these are watched.
    // Whether the session is fetched at all is part of the identity; the
    // function that fetches it is not.
    //
    // One source per value rather than one getter returning an array: a new
    // function re-runs whatever reads it, and a getter that builds a fresh array
    // each time it runs reads as a change even when every value in it is the same.
    watch(
      [
        () => props.sessionId,
        () => props.clientSecret,
        () => props.fetchSession !== undefined,
        () => props.reuseKey,
        () => props.origin,
        () => props.title,
      ],
      mount,
    );
    onBeforeUnmount(() => {
      teardown?.();
      teardown = null;
    });

    // `class` and `style` fall through to this element, for layout.
    return () => h('div', { ref: container });
  },
});
