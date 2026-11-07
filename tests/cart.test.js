import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCart } from '../src/scripts/cart.js';

test('sanitizeCart keeps a catalog product with a valid variant', () => {
  assert.deepEqual(
    sanitizeCart([{ productId: 'risol-mayo', variant: 'Spicy', quantity: 2 }]),
    [{ productId: 'risol-mayo', variant: 'Spicy', quantity: 2 }]
  );
});

test('sanitizeCart drops unknown products and invalid variants', () => {
  assert.deepEqual(
    sanitizeCart([
      { productId: 'risol-mayo', variant: 'Nope', quantity: 1 },
      { productId: 'coffee-bun', variant: 'Weird', quantity: 1 },
      { productId: 'unknown', variant: null, quantity: 1 },
    ]),
    [{ productId: 'coffee-bun', variant: null, quantity: 1 }]
  );
});

test('sanitizeCart tolerates malformed entries', () => {
  assert.deepEqual(sanitizeCart(null), []);
  assert.deepEqual(
    sanitizeCart([null, {}, { productId: 'matcha' }]),
    [{ productId: 'matcha', variant: null }]
  );
});
