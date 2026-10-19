import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as react from '../src/index.js';
import * as browser from '@flutterwavebnw/checkout-sdk/browser';

// The store moved into the SDK's browser entry so every framework binding drives a
// session through one implementation. This package still exports it, and must
// export that same class rather than a copy: a second copy is exactly the drift
// the move exists to prevent, and a React consumer importing the store from here
// must keep getting what they got before.
test('the store is the SDK browser entry store, re-exported unchanged', () => {
  assert.equal(react.CheckoutSessionStore, browser.CheckoutSessionStore);
});

test('the hook and both components are exported', () => {
  assert.equal(typeof react.useCheckoutSession, 'function');
  assert.equal(typeof react.CheckoutDropIn, 'function');
  assert.equal(typeof react.CardField, 'function');
});
