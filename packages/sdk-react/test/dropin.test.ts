// The drop-in component is a wrapper over the runtime, so what is worth proving
// is the wrapping: that the session reaches `mount` in whichever shape the parent
// gave it, that a frame goes with the component, and — the part a React wrapper
// most easily gets wrong — that a parent re-rendering with a fresh inline
// `fetchSession` is not a new purchase. A remount there would ask the merchant's
// server for another session on every render of the page around the checkout.
//
// The runtime is stood in for on `window.FlutterwavebnwCheckout`, where the loader looks
// first, which is what a page with the script tag already on it looks like.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { MountOptions, SessionCredentials } from '@flutterwavebnw/checkout-runtime';

interface FakeFrame {
  options: MountOptions;
  destroyed: boolean;
}

const frames: FakeFrame[] = [];
// Any origin will do: the runtime is already on the page, so nothing is fetched.
const ORIGIN = 'https://checkout.test';
let dom: JSDOM;
let createRoot: typeof import('react-dom/client').createRoot;
let CheckoutDropIn: typeof import('../src/CheckoutDropIn.js').CheckoutDropIn;

before(async () => {
  // A DOM has to exist before react-dom is imported.
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.example/checkout' });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  // Installed rather than assigned: some Node versions define `navigator` as a
  // getter-only accessor, and assigning to one throws under ESM strict mode.
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  (dom.window as unknown as Record<string, unknown>).FlutterwavebnwCheckout = {
    protocolVersion: 1,
    mount(options: MountOptions) {
      const frame: FakeFrame = { options, destroyed: false };
      frames.push(frame);
      return { frame: null, destroy: () => (frame.destroyed = true) };
    },
  };
  ({ createRoot } = await import('react-dom/client'));
  ({ CheckoutDropIn } = await import('../src/CheckoutDropIn.js'));
});

after(() => dom.window.close());

beforeEach(() => {
  frames.length = 0;
  dom.window.document.body.innerHTML = '';
});

/** Let the runtime load, which resolves a tick later even when it is on the page. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(element: React.ReactElement, root?: Root): Promise<Root> {
  const target = root ?? createRoot(dom.window.document.body.appendChild(dom.window.document.createElement('div')));
  await act(async () => {
    target.render(element);
    await flush();
  });
  return target;
}

test('a session the page holds is mounted as it was given', async () => {
  const root = await render(
    React.createElement(CheckoutDropIn, { origin: ORIGIN, sessionId: 'cs_1', clientSecret: 'cs_1_secret' }),
  );
  assert.equal(frames.length, 1);
  const options = frames[0]!.options;
  assert.equal(options.sessionId, 'cs_1');
  assert.equal(options.clientSecret, 'cs_1_secret');
  assert.equal(options.fetchSession, undefined);

  await act(async () => root.unmount());
  assert.equal(frames[0]!.destroyed, true, 'the frame goes with the component');
});

test('a fetched session is fetched by the runtime, under the key the parent named', async () => {
  const seen: string[] = [];
  const fetchSession = async (): Promise<SessionCredentials> => {
    seen.push('fetch');
    return { sessionId: 'cs_1', clientSecret: 'cs_1_secret' };
  };
  const root = await render(React.createElement(CheckoutDropIn, { origin: ORIGIN, fetchSession, reuseKey: 'order_42' }));

  assert.equal(frames.length, 1);
  const options = frames[0]!.options;
  assert.equal(options.reuseKey, 'order_42');
  assert.equal(options.sessionId, undefined, 'a fetched mount passes no session of its own');
  assert.deepEqual(await options.fetchSession!(), { sessionId: 'cs_1', clientSecret: 'cs_1_secret' });
  assert.deepEqual(seen, ['fetch']);
  await act(async () => root.unmount());
});

test('a parent passing a new inline fetchSession on every render does not remount', async () => {
  let latest = '';
  const element = (label: string) =>
    React.createElement(CheckoutDropIn, {
      origin: ORIGIN,
      fetchSession: async () => {
        latest = label;
        return { sessionId: 'cs_1', clientSecret: 'cs_1_secret' };
      },
      reuseKey: 'order_42',
      className: label,
    });

  const root = await render(element('first'));
  await render(element('second'), root);
  assert.equal(frames.length, 1, 'a re-render is not a new purchase');

  // The mounted frame still calls whichever function the parent passed last.
  await frames[0]!.options.fetchSession!();
  assert.equal(latest, 'second');

  // A different purchase is.
  await render(
    React.createElement(CheckoutDropIn, {
      origin: ORIGIN,
      fetchSession: async () => ({ sessionId: 'cs_2', clientSecret: 'cs_2_secret' }),
      reuseKey: 'order_43',
    }),
    root,
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.destroyed, true);
  await act(async () => root.unmount());
});

test('a closed checkout reaches onClosed with its session', async () => {
  const told: string[] = [];
  const root = await render(
    React.createElement(CheckoutDropIn, {
      origin: ORIGIN,
      sessionId: 'cs_1',
      clientSecret: 'cs_1_secret',
      onClosed: ({ sessionId }: { sessionId: string }) => told.push(sessionId),
    }),
  );
  frames[0]!.options.onClosed?.({ sessionId: 'cs_1' });
  assert.deepEqual(told, ['cs_1']);
  await act(async () => root.unmount());
});

test('a failed fetch reaches onError, the same handler as a runtime that never loaded', async () => {
  const errors: string[] = [];
  const root = await render(
    React.createElement(CheckoutDropIn, {
      origin: ORIGIN,
      fetchSession: async () => ({ sessionId: 'cs_1', clientSecret: 'cs_1_secret' }),
      onError: (err: Error) => errors.push(err.message),
    }),
  );
  frames[0]!.options.onError?.(new Error('cart is empty'));
  assert.deepEqual(errors, ['cart is empty']);
  await act(async () => root.unmount());
});
