import { PRODUCTS, PICKUP_LOCATION } from '../data/products.js';
import { formatRupiah } from '../lib/order-input.js';

export { PRODUCTS, PICKUP_LOCATION, formatRupiah };

export function addItem(cart, productId, variant) {
  const key = variant ? `${productId}:${variant}` : productId;
  const item = cart.find((entry) => entry.key === key);
  if (item) return cart.map((entry) => entry.key === key ? { ...entry, quantity: entry.quantity + 1 } : entry);
  return [...cart, { key, productId, variant, quantity: 1 }];
}

export function updateQuantity(cart, key, quantity) {
  return quantity > 0 ? cart.map((item) => item.key === key ? { ...item, quantity } : item) : cart.filter((item) => item.key !== key);
}

export function cartCount(cart) {
  return cart.reduce((total, item) => total + item.quantity, 0);
}

export function cartTotal(cart) {
  return cart.reduce((total, item) => {
    const product = PRODUCTS.find((entry) => entry.id === item.productId);
    return total + (product?.price || 0) * item.quantity;
  }, 0);
}

export function validateCheckout({ name, contact, cart }) {
  if (!cart.length) return 'Keranjang masih kosong.';
  if (!name.trim() || !contact.trim()) return 'Isi nama dan kontak dulu.';
  return '';
}

export function loadCart(storage) {
  try {
    const parsed = JSON.parse(storage.getItem('cart') || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item?.productId && item.quantity > 0) : [];
  } catch {
    return [];
  }
}

export function saveCart(storage, cart) {
  storage.setItem('cart', JSON.stringify(cart));
}

export async function submitOrder(payload) {
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Pesanan belum dapat disimpan. Coba lagi.');
  return result;
}

if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  const sample = addItem([], 'risol-mayo', 'Spicy');
  console.assert(cartTotal(sample) === 15000, 'cart total self-check failed');
  console.assert(validateCheckout({ name: '', contact: '', cart: sample }), 'validation self-check failed');
}
