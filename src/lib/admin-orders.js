import { canTransition, isOrderOrderId } from './admin-shared.js';

const RECAP_STATUSES = ['sudah dibayar', 'siap diambil', 'selesai'];

export function assertOrderId(value) {
  if (!isOrderOrderId(value)) throw new Error('Order ID tidak valid.');
}

export async function getCounts(service) {
  const statuses = ['menunggu pembayaran', 'sudah dibayar', 'siap diambil', 'selesai', 'batal'];
  const results = await Promise.all(
    statuses.map((status) =>
      service.from('orders').select('id', { count: 'exact', head: true }).eq('status', status)
    )
  );
  const counts = {};
  statuses.forEach((status, index) => { counts[status] = results[index].count ?? 0; });
  return counts;
}

// The list never selects contact: the WhatsApp number must not reach the browser
// until an admin opens one order. Items are embedded so each card can show a
// one-line summary.
export async function listOrders(service, { status = '', q = '' } = {}) {
  let query = service
    .from('orders')
    .select('id, customer_name, total, status, created_at, updated_at, paid_at, order_items(product_name, variant, quantity)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) query = query.eq('status', status);
  if (q) {
    // The term is matched against id, name, and the trailing digits of the
    // WhatsApp number. contact is never selected, so the full number stays out
    // of the list response.
    const term = String(q).replace(/[%,:()'"]/g, ' ').trim();
    if (term) {
      const digits = term.replace(/\D/g, '');
      const parts = [`id.ilike.%${term}%`, `customer_name.ilike.%${term}%`];
      if (digits.length >= 4) parts.push(`contact.like.%${digits}`);
      query = query.or(parts.join(','));
    }
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getOrderDetail(service, orderId) {
  assertOrderId(orderId);
  const { data: order, error } = await service.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) return null;
  const [items, events] = await Promise.all([
    service.from('order_items').select('product_name, variant, quantity, unit_price, subtotal').eq('order_id', orderId).order('id'),
    service.from('order_events').select('dari_status, ke_status, created_at, admin_users(nama)').eq('order_id', orderId).order('created_at', { ascending: false }),
  ]);
  return { ...order, items: items.data ?? [], events: events.data ?? [] };
}

export async function getRecap(service) {
  const { data, error } = await service
    .from('orders')
    .select('status, total, order_items(product_name, variant, quantity, subtotal)')
    .in('status', RECAP_STATUSES);
  if (error) throw new Error(error.message);

  const perProduct = new Map();
  const perStatus = {};
  for (const order of data ?? []) {
    perStatus[order.status] = (perStatus[order.status] ?? 0) + (order.total ?? 0);
    for (const item of order.order_items ?? []) {
      const key = `${item.product_name}|${item.variant ?? ''}`;
      const entry = perProduct.get(key) ?? {
        product_name: item.product_name,
        variant: item.variant ?? null,
        quantity: 0,
        subtotal: 0,
      };
      entry.quantity += item.quantity;
      entry.subtotal += item.subtotal;
      perProduct.set(key, entry);
    }
  }
  return { perProduct: [...perProduct.values()], perStatus };
}

export async function setStatus(service, { orderId, fromStatus, toStatus, adminUserId }) {
  assertOrderId(orderId);
  if (!canTransition(fromStatus, toStatus)) {
    return { ok: false, invalid: true, error: 'Transisi status tidak diizinkan.' };
  }
  const { data, error } = await service.rpc('admin_set_order_status', {
    p_order_id: orderId,
    p_from_status: fromStatus,
    p_to_status: toStatus,
    p_admin_user_id: adminUserId,
  });
  if (error) return { ok: false, error: error.message };
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const order = rows[0];
  if (!order?.order_id) {
    return { ok: false, changed: false, error: 'Status sudah berubah. Muat ulang.' };
  }
  return { ok: true, order };
}
