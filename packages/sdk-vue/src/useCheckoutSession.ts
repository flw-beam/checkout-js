// The Vue binding: a thin composable over CheckoutSessionStore, which lives in the
// SDK's browser entry so every framework binding drives a session through the
// same code. It fetches the session once the component is mounted, watches it
// while a rail is answering, and returns the current state as refs plus the bound
// actions. Works in Vue 3 and Nuxt: a server render sees the `loading` snapshot
// and makes no request, because the fetch happens only in the browser.
import {
  computed,
  onMounted,
  onScopeDispose,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
} from 'vue';
import { CheckoutSessionStore, isWaitingOnRail } from '@flutterwavebnw/checkout-sdk/browser';
import type { CheckoutSessionStoreOptions, CheckoutState } from '@flutterwavebnw/checkout-sdk/browser';

export interface UseCheckoutSessionOptions extends CheckoutSessionStoreOptions {
  /**
   * Whether to hold a live watch while the session is waiting on a rail. Default
   * true, and leaving it on is almost always right: it is what keeps a buyer on a
   * bank transfer or a wallet prompt from sitting in front of a stale screen, and
   * it is why this composable needs no polling loop.
   */
  watch?: boolean;
}

export interface UseCheckoutSession {
  /** `loading` until the first fetch resolves, then `ready`, or `error` if it failed. */
  phase: ComputedRef<CheckoutState['phase']>;
  /** The current session snapshot the core computed, or null before the first load. */
  session: ComputedRef<CheckoutState['session']>;
  /** The ranked eligible methods, once fetched with `refreshMethods` (null until then). */
  methods: ComputedRef<CheckoutState['methods']>;
  /** True while a mutating action (or a load) is in flight. */
  busy: ComputedRef<boolean>;
  /** The last error, if any. Cleared when the next action starts. */
  error: ComputedRef<unknown>;
  /** True while a live watch is holding this session's state. */
  watching: ComputedRef<boolean>;
  /** Re-fetch the session. */
  refresh: CheckoutSessionStore['load'];
  /** Fetch the ranked eligible methods into `methods`. */
  refreshMethods: CheckoutSessionStore['refreshMethods'];
  quoteFx: CheckoutSessionStore['quoteFx'];
  selectMethod: CheckoutSessionStore['selectMethod'];
  setCustomer: CheckoutSessionStore['setCustomer'];
  authorize: CheckoutSessionStore['authorize'];
  completeAction: CheckoutSessionStore['completeAction'];
  cancel: CheckoutSessionStore['cancel'];
}

/**
 * Drive one CheckoutSession from a Vue component. Pass the session id and the
 * session-scoped `client_secret` — as a plain object, a ref, or a getter; the
 * session is re-read whenever the id, the secret, or the base URL changes. The
 * returned `session` is always the authoritative one the core computed.
 *
 * While the session is waiting on a rail — money in flight, a transfer to send, a
 * wallet prompt to approve — the composable holds a live watch, so `session`
 * moves on its own as the core learns what the rail said. `watching` says whether
 * one is held. Nothing in a component needs to poll.
 *
 * Call it from a component's `setup`: the fetch is tied to the component being
 * mounted, and everything it holds is released when the component goes away.
 */
export function useCheckoutSession(options: MaybeRefOrGetter<UseCheckoutSessionOptions>): UseCheckoutSession {
  const store = shallowRef(new CheckoutSessionStore(toValue(options)));
  const state = shallowRef<CheckoutState>(store.value.getSnapshot());
  let mounted = false;
  let unsubscribe = store.value.subscribe(() => (state.value = store.value.getSnapshot()));

  // The store's own error state carries a failed load, so the rejection is not
  // left unhandled on top of it.
  const load = () => void store.value.load().catch(() => {});

  onMounted(() => {
    mounted = true;
    load();
  });

  // A new session, secret, or base URL is a different session to drive, so it
  // gets a fresh store rather than the old one repointed — the same identity rule
  // the React hook applies. Anything else changing leaves a healthy store alone.
  watch(
    () => {
      const o = toValue(options);
      return [o.sessionId, o.clientSecret, o.baseUrl] as const;
    },
    () => {
      unsubscribe();
      const next = new CheckoutSessionStore(toValue(options));
      unsubscribe = next.subscribe(() => (state.value = next.getSnapshot()));
      store.value = next;
      state.value = next.getSnapshot();
      if (mounted) load();
    },
  );

  // Watch while the rail is answering, and only then. Watching before there is
  // anything to wait for would hold a connection open through a buyer filling in
  // a form, and the core holds one stream per session — so an idle watch here is
  // one the surface actually waiting on that session cannot have.
  //
  // Keyed on the condition rather than on the session, so an unrelated
  // transition does not tear a healthy watch down and open another.
  const waiting = computed(() => (state.value.session ? isWaitingOnRail(state.value.session) : false));
  watch(
    [store, waiting],
    ([current, isWaiting], _previous, onCleanup) => {
      if (!(toValue(options).watch ?? true) || !isWaiting) return;
      onCleanup(current.watch());
    },
    { immediate: true },
  );

  onScopeDispose(() => unsubscribe());

  return {
    phase: computed(() => state.value.phase),
    session: computed(() => state.value.session),
    methods: computed(() => state.value.methods),
    busy: computed(() => state.value.busy),
    error: computed(() => state.value.error),
    watching: computed(() => state.value.watching),
    // Each action addresses whichever store is current, so a template holding
    // one of these across a session change never drives the session it left.
    refresh: () => store.value.load(),
    refreshMethods: () => store.value.refreshMethods(),
    quoteFx: (body) => store.value.quoteFx(body),
    selectMethod: (body) => store.value.selectMethod(body),
    setCustomer: (body) => store.value.setCustomer(body),
    authorize: (body) => store.value.authorize(body),
    completeAction: (body) => store.value.completeAction(body),
    cancel: (body) => store.value.cancel(body),
  };
}
