import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedTransitions,
  buildAdminChatMessage,
  buildWaLink,
  canTransition,
  createActionGuard,
  formatRelativeTime,
  isOrderOrderId,
  isStale,
  maskContact,
  summarizeItems,
} from '../src/lib/admin-shared.js';
import { assertOrderId, getCounts, getRecap, listOrders, setStatus } from '../src/lib/admin-orders.js';

function fakeService({ rows = [], error = null, rpcResult = { data: null, error: null } } = {}) {
  const calls = { selects: [], ors: [], rpcs: [] };
  const chain = {
    select: (columns) => { calls.selects.push(columns); return chain; },
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    in: () => chain,
    or: (filter) => { calls.ors.push(filter); return chain; },
    maybeSingle: async () => ({ data: rows[0] ?? null, error }),
    then: (onFulfilled, onRejected) => Promise.resolve({ data: rows, error }).then(onFulfilled, onRejected),
  };
  return {
    calls,
    from: () => chain,
    rpc: async (name, params) => { calls.rpcs.push({ name, params }); return rpcResult; },
  };
}

test('order id must match ^TIG-[0-9]+$', () => {
  assert.equal(isOrderOrderId('TIG-0001'), true);
  assert.equal(isOrderOrderId('TIG-1'), true);
  assert.throws(() => assertOrderId('tig-1'), /tidak valid/);
  assert.throws(() => assertOrderId('BUKAN-TIG'), /tidak valid/);
  assert.throws(() => assertOrderId('TIG-1 OR 1=1'), /tidak valid/);
});

test('transition whitelist: one step forward, one step back, cancellations', () => {
  assert.deepEqual(allowedTransitions('menunggu pembayaran'), ['sudah dibayar', 'batal']);
  assert.deepEqual(allowedTransitions('sudah dibayar'), ['siap diambil', 'menunggu pembayaran', 'batal']);
  assert.deepEqual(allowedTransitions('siap diambil'), ['selesai', 'sudah dibayar']);
  assert.deepEqual(allowedTransitions('selesai'), ['siap diambil']);
  assert.deepEqual(allowedTransitions('batal'), []);

  assert.equal(canTransition('menunggu pembayaran', 'sudah dibayar'), true);
  assert.equal(canTransition('sudah dibayar', 'menunggu pembayaran'), true);
  assert.equal(canTransition('siap diambil', 'sudah dibayar'), true);
  assert.equal(canTransition('selesai', 'siap diambil'), true);
  assert.equal(canTransition('sudah dibayar', 'batal'), true);
  assert.equal(canTransition('siap diambil', 'batal'), false);
  assert.equal(canTransition('menunggu pembayaran', 'selesai'), false);
  assert.equal(canTransition('batal', 'menunggu pembayaran'), false);
});

test('formatRelativeTime renders WIB-relative labels', () => {
  const now = new Date('2026-11-07T10:00:00+07:00').getTime();
  assert.equal(formatRelativeTime(new Date(now - 30 * 1000), now), 'baru saja');
  assert.equal(formatRelativeTime(new Date(now - 5 * 60 * 1000), now), '5 menit lalu');
  assert.equal(formatRelativeTime(new Date('2026-11-07T08:00:00+07:00'), now), '2 jam lalu');
  assert.equal(formatRelativeTime(new Date('2026-11-06T14:20:00+07:00'), now), 'kemarin 14.20');
  assert.equal(formatRelativeTime(new Date('2026-11-05T09:00:00+07:00'), now), '2 hari lalu');
  assert.equal(formatRelativeTime(null, now), '-');
});

test('isStale flags orders older than three hours', () => {
  assert.equal(isStale(new Date(Date.now() - 4 * 3600 * 1000)), true);
  assert.equal(isStale(new Date(Date.now() - 2 * 3600 * 1000)), false);
  assert.equal(isStale(null), false);
});

test('action guard blocks a double tap', () => {
  const guard = createActionGuard();
  assert.equal(guard.begin('TIG-0001:sudah dibayar'), true);
  assert.equal(guard.begin('TIG-0001:sudah dibayar'), false);
  assert.equal(guard.isBusy('TIG-0001:sudah dibayar'), true);
  guard.end('TIG-0001:sudah dibayar');
  assert.equal(guard.begin('TIG-0001:sudah dibayar'), true);
});

test('summarizeItems flattens items into one line', () => {
  assert.equal(
    summarizeItems([
      { product_name: 'Risol Mayo', variant: 'Mix', quantity: 1 },
      { product_name: 'Coffee Bun', variant: null, quantity: 2 },
    ]),
    'Risol Mayo Mix x1, Coffee Bun x2'
  );
  assert.equal(summarizeItems([]), '');
  assert.equal(summarizeItems(null), '');
});

test('maskContact hides the middle digits', () => {
  assert.equal(maskContact('6281234567890'), '6281*****890');
  assert.equal(maskContact('62812'), '***');
  assert.equal(maskContact(null), '***');
});

test('admin chat message keeps [isi] placeholders and strips formatting characters', () => {
  const message = buildAdminChatMessage({ nama: 'Ana *_~`Test', orderId: 'TIG-0001' });
  assert.equal(
    message,
    'Halo Ana Test, pesanan TIG-0001 sudah kami terima. Jadwal pickup: [isi]. Catatan: [isi].'
  );
  assert.ok(!message.includes('*'));
  assert.equal(buildAdminChatMessage({ nama: '   ', orderId: 'TIG-2' }).startsWith('Halo pelanggan,'), true);
});

test('wa link strips separators and encodes the message', () => {
  const link = buildWaLink('+62 812-3456-7890', 'Halo Ana, pesanan TIG-1');
  assert.equal(link, 'https://wa.me/6281234567890?text=Halo%20Ana%2C%20pesanan%20TIG-1');
});

test('listOrders never selects the WhatsApp number', async () => {
  const service = fakeService({ rows: [] });
  await listOrders(service, { status: 'menunggu pembayaran', q: 'Ana' });
  assert.equal(service.calls.selects.length, 1);
  assert.equal(/contact/.test(service.calls.selects[0]), false);
});

test('search matches id, name, and the last four WhatsApp digits', async () => {
  const digits = fakeService({ rows: [] });
  await listOrders(digits, { q: '7890' });
  assert.equal(digits.calls.ors[0], 'id.ilike.%7890%,customer_name.ilike.%7890%,contact.like.%7890');

  const withoutPrefix = fakeService({ rows: [] });
  await listOrders(withoutPrefix, { q: '0001' });
  assert.match(withoutPrefix.calls.ors[0], /id\.ilike\.%0001%/);

  const name = fakeService({ rows: [] });
  await listOrders(name, { q: 'Ana' });
  assert.equal(name.calls.ors[0], 'id.ilike.%Ana%,customer_name.ilike.%Ana%');
});

test('getCounts maps one count per status', async () => {
  const counts = [1, 2, 3, 4, 5];
  let index = 0;
  const service = {
    from: () => ({
      select: () => ({
        eq: () => ({ then: async (resolve) => resolve({ count: counts[index++], error: null }) }),
      }),
    }),
  };
  assert.deepEqual(await getCounts(service), {
    'menunggu pembayaran': 1,
    'sudah dibayar': 2,
    'siap diambil': 3,
    'selesai': 4,
    'batal': 5,
  });
});

test('getRecap aggregates quantity and rupiah per product and per status', async () => {
  const service = fakeService({
    rows: [
      { status: 'sudah dibayar', total: 43000, order_items: [
        { product_name: 'Risol Mayo', variant: 'Mix', quantity: 1, subtotal: 15000 },
        { product_name: 'Coffee Bun', variant: null, quantity: 2, subtotal: 24000 },
      ] },
      { status: 'selesai', total: 16000, order_items: [
        { product_name: 'Risol Mayo', variant: 'Mix', quantity: 1, subtotal: 15000 },
        { product_name: 'Iced Matcha Latte', variant: null, quantity: 1, subtotal: 16000 },
      ] },
    ],
  });
  const recap = await getRecap(service);
  assert.deepEqual(recap.perStatus, { 'sudah dibayar': 43000, selesai: 16000 });
  const risol = recap.perProduct.find((entry) => entry.product_name === 'Risol Mayo');
  assert.deepEqual(risol, { product_name: 'Risol Mayo', variant: 'Mix', quantity: 2, subtotal: 30000 });
  assert.equal(recap.perProduct.find((entry) => entry.product_name === 'Coffee Bun').quantity, 2);
});

test('setStatus rejects an illegal transition before calling the RPC', async () => {
  const service = fakeService();
  const result = await setStatus(service, {
    orderId: 'TIG-0001', fromStatus: 'menunggu pembayaran', toStatus: 'selesai', adminUserId: 'u1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.invalid, true);
  assert.equal(service.calls.rpcs.length, 0);
});

test('setStatus surfaces the guard failure as "status already changed"', async () => {
  const service = fakeService({ rpcResult: { data: [], error: null } });
  const result = await setStatus(service, {
    orderId: 'TIG-0001', fromStatus: 'menunggu pembayaran', toStatus: 'sudah dibayar', adminUserId: 'u1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.match(result.error, /Muat ulang/);
  assert.equal(service.calls.rpcs[0].name, 'admin_set_order_status');
});

test('setStatus returns the changed row', async () => {
  const service = fakeService({
    rpcResult: { data: [{ order_id: 'TIG-0001', status: 'sudah dibayar' }], error: null },
  });
  const result = await setStatus(service, {
    orderId: 'TIG-0001', fromStatus: 'menunggu pembayaran', toStatus: 'sudah dibayar', adminUserId: 'u1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.order.status, 'sudah dibayar');
  assert.deepEqual(service.calls.rpcs[0].params, {
    p_order_id: 'TIG-0001',
    p_from_status: 'menunggu pembayaran',
    p_to_status: 'sudah dibayar',
    p_admin_user_id: 'u1',
  });
});
