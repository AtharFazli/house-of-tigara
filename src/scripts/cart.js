export const PRODUCTS = [
  { id: 'risol-mayo', name: 'Risol Mayo', description: 'Kulit renyah keemasan berpadu smoked beef gurih, telur, dan creamy mayo racikan khas Tigara.', price: 15000, unit: 'box isi 4', image: '/images/products/risol-4pcs.webp' },
  { id: 'coffee-bun', name: 'Coffee Bun', description: 'Roti lembut beraroma kopi pekat dengan lelehan mentega gurih di dalamnya.', price: 12000, unit: 'pcs', image: '/images/products/coffee-bun.webp' },
  { id: 'matcha', name: 'Iced Matcha Latte', description: 'Matcha dengan susu segar dan sirup vanila, disajikan dingin.', price: 16000, unit: 'cup', image: '/images/products/matcha.webp' },
];

export const formatRupiah = (value) => `Rp ${value.toLocaleString('id-ID')}`;

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

export const PICKUP_LOCATION = 'TUJ Kampus Stasiun Bumi';

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
  // ponytail: local placeholder; replace body with Supabase insert after backend approval.
  await Promise.resolve();
  return { ok: true, orderId: `TIG-${String(Date.now()).slice(-4)}`, ...payload };
}

if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  const sample = addItem([], 'risol-mayo', 'Spicy');
  console.assert(cartTotal(sample) === 15000, 'cart total self-check failed');
  console.assert(validateCheckout({ name: '', contact: '', cart: sample }), 'validation self-check failed');
}
