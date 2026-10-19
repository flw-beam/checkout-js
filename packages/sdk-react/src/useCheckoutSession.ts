// The React binding: a thin useSyncExternalStore wrapper over CheckoutSessionStore,
// which lives in the SDK's browser entry so every framework binding drives a
// session through the same code. It fetches the session on mount, watches it
// while a rail is answering, and returns the current state plus the bound
// actions. Works in React web, Next.js (the store snapshot is SSR-safe — it
// starts in `loading`), and React Native.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { CheckoutSessionStore, isWaitingOnRail } from '@flutterwavebnw/checkout-sdk/browser';
import type { CheckoutSessionStoreOptions, CheckoutState } from '@flutterwavebnw/checkout-sdk/browser';

export interface UseCheckoutSessionOptions extends CheckoutSessionStoreOptions {
  /**
   * Whether to hold a live watch while the session is waiting on a rail. Default
   * true, and leaving it on is almost always right: it is what keeps a buyer on a
   * bank transfer or a wallet prompt from sitting in front of a stale screen, and
   * it is why this hook needs no polling loop.
   *
   * Turn it off only to drive the watch yourself — `store.watch()` is the same
   * thing under manual control.
   */
  watch?: boolean;
}

export interface UseCheckoutSession extends CheckoutState {
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
 * Drive one CheckoutSession from a React component. Pass the session id and the
 * session-scoped `client_secret`; the hook loads the session on mount and
 * exposes the verbs a browser may drive. The returned `session` is always the
 * authoritative one the core computed.
 *
 * While the session is waiting on a rail — money in flight, a transfer to send, a
 * wallet prompt to approve — the hook holds a live watch, so `session` moves on
 * its own as the core learns what the rail said. `watching` says whether one is
 * held. Nothing in a component needs to poll.
 */
export function useCheckoutSession(options: UseCheckoutSessionOptions): UseCheckoutSession {
  // Rebuild the store only when the identity of the session/credential changes.
  const store = useMemo(
    () => new CheckoutSessionStore(options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.sessionId, options.clientSecret, options.baseUrl],
  );

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    void store.load();
  }, [store]);

  // Watch while the rail is answering, and only then. Watching before there is
  // anything to wait for would hold a connection open through a buyer filling in
  // a form, and the core holds one stream per session — so an idle watch here is
  // one the surface actually waiting on that session cannot have.
  //
  // Depends on the condition rather than on the session, so an unrelated
  // transition does not tear a healthy watch down and open another.
  const waiting = state.session ? isWaitingOnRail(state.session) : false;
  const enabled = options.watch ?? true;
  useEffect(() => {
    if (!enabled || !waiting) return;
    return store.watch();
  }, [store, enabled, waiting]);

  return {
    ...state,
    refresh: store.load,
    refreshMethods: store.refreshMethods,
    quoteFx: store.quoteFx,
    setCustomer: store.setCustomer,
    selectMethod: store.selectMethod,
    authorize: store.authorize,
    completeAction: store.completeAction,
    cancel: store.cancel,
  };
}
