import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderMessage, isValidContact, normalizeOrderInput } from '../src/lib/order-input.js';

test('normalizes contact and derives order totals from trusted catalog', () => {
  assert.deepEqual(normalizeOrderInput({
    idempotencyKey: 'b3d11a20-9476-4a55-b699-123456789abc',
    name: '  Ana  ',
    contact: '+62 812-3456-7890',
    items: [{ productId: 'risol-mayo', variant: 'Spicy', quantity: 2 }],
  }), {
    idempotencyKey: 'b3d11a20-9476-4a55-b699-123456789abc',
    customerName: 'Ana',
    contact: '6281234567890',
    items: [{ product_id: 'risol-mayo', product_name: 'Risol Mayo', variant: 'Spicy', quantity: 2, unit_price: 15000, subtotal: 30000 }],
    total: 30000,
  });
});

test('rejects invalid product, variant, and quantity at server boundary', () => {
  const base = { idempotencyKey: 'b3d11a20-9476-4a55-b699-123456789abc', name: 'Ana', contact: '081234567890' };
  assert.throws(() => normalizeOrderInput({ ...base, items: [{ productId: 'unknown', quantity: 1 }] }), /Isi keranjang tidak valid/);
  assert.throws(() => normalizeOrderInput({ ...base, items: [{ productId: 'risol-mayo', variant: 'Other', quantity: 1 }] }), /Isi keranjang tidak valid/);
  assert.throws(() => normalizeOrderInput({ ...base, items: [{ productId: 'coffee-bun', quantity: 21 }] }), /Isi keranjang tidak valid/);
});

test('accepts common Indonesian phone formats', () => {
  for (const contact of ['081234567890', '0812 3456 7890', '+6281234567890', '6281234567890']) {
    assert.equal(isValidContact(contact), true, contact);
  }
  assert.equal(isValidContact('0812'), false);
  assert.equal(isValidContact('6281'), false);
});

test('formats WhatsApp order message with numbered items and rupiah totals', () => {
  const message = buildOrderMessage({
    orderId: 'TIG-0001',
    name: 'Ana *_~`Test',
    items: [
      { productId: 'risol-mayo', variant: 'Mix', quantity: 1 },
      { productId: 'coffee-bun', variant: null, quantity: 2 },
      { productId: 'matcha', variant: null, quantity: 1 },
    ],
  });
  const lines = message.split('\n');
  assert.deepEqual(lines, [
    '*PRE-ORDER HOUSE OF TIGARA*',
    'Order ID: TIG-0001',
    'Nama: Ana Test',
    '',
    '*Pesanan*',
    '1. Risol Mayo (Mix) x1 - Rp 15.000',
    '2. Coffee Bun x2 - Rp 24.000',
    '3. Iced Matcha Latte x1 - Rp 16.000',
    '',
    '*Total: Rp 55.000*',
    'Pembayaran: QRIS (sudah dibayar)',
    '',
    'Mohon info jadwal dan catatan pickup. Terima kasih!',
  ]);
  const subtotal = 1 * 15000 + 2 * 12000 + 1 * 16000;
  assert.ok(message.includes(`*Total: Rp ${subtotal.toLocaleString('id-ID')}*`));
});
