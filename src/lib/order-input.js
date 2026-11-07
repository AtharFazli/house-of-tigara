import { PRODUCTS } from '../data/products.js';

const productById = new Map(PRODUCTS.map((product) => [product.id, product]));

const MAX_QUANTITY = 20;

export function normalizeContact(value) {
  const raw = typeof value === 'string' ? value.replace(/[\s()+.-]/g, '') : '';
  return raw.startsWith('0') ? `62${raw.slice(1)}` : raw;
}

export function isValidContact(value) {
  return /^628[0-9]{7,12}$/.test(normalizeContact(value));
}

export function normalizeOrderInput(input) {
  const idempotencyKey = typeof input?.idempotencyKey === 'string' ? input.idempotencyKey : '';
  const customerName = typeof input?.name === 'string' ? input.name.trim() : '';
  const contact = normalizeContact(input?.contact);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)
    || customerName.length < 1 || customerName.length > 120
    || !/^628[0-9]{7,12}$/.test(contact)
    || !Array.isArray(input?.items) || input.items.length < 1 || input.items.length > 5) {
    throw new Error('Data pesanan tidak valid.');
  }

  let quantityTotal = 0;
  const items = input.items.map((item) => {
    const product = productById.get(item?.productId);
    const quantity = item?.quantity;
    const variant = item?.variant || null;
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 20
      || (product.variants.length ? !product.variants.includes(variant) : variant !== null)) {
      throw new Error('Isi keranjang tidak valid.');
    }
    quantityTotal += quantity;
    return {
      product_id: item.productId,
      product_name: product.name,
      variant,
      quantity,
      unit_price: product.price,
      subtotal: product.price * quantity,
    };
  });
  if (quantityTotal > 20) throw new Error('Isi keranjang tidak valid.');

  return {
    idempotencyKey,
    customerName,
    contact,
    items,
    total: items.reduce((sum, item) => sum + item.subtotal, 0),
  };
}
