import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ORDER_HASH_SECRET, SUPABASE_SECRET_KEY, SUPABASE_URL } from 'astro:env/server';
import { normalizeOrderInput } from '../../lib/order-input.js';

export const prerender = false;

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');

export async function POST({ request, clientAddress }) {
  let input;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 16_384) return json({ error: 'Data pesanan terlalu besar.' }, 413);
    input = JSON.parse(body);
  } catch {
    return json({ error: 'Format data pesanan tidak valid.' }, 400);
  }

  if (input?.website) return json({ error: 'Data pesanan tidak valid.' }, 400);

  let order;
  try {
    order = normalizeOrderInput(input);
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !ORDER_HASH_SECRET || ORDER_HASH_SECRET.length < 32) {
    return json({ error: 'Layanan pesanan belum dikonfigurasi.' }, 503);
  }

  let ipAddress;
  try {
    ipAddress = clientAddress;
  } catch {
    return json({ error: 'Alamat jaringan tidak tersedia.' }, 503);
  }
  if (!ipAddress) return json({ error: 'Alamat jaringan tidak tersedia.' }, 503);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.rpc('create_order_atomic', {
    p_idempotency_key: order.idempotencyKey,
    p_customer_name: order.customerName,
    p_contact: order.contact,
    p_contact_hash: hmac(ORDER_HASH_SECRET, `contact:${order.contact}`),
    p_ip_hash: hmac(ORDER_HASH_SECRET, `ip:${ipAddress}`),
    p_items: order.items,
    p_total: order.total,
  });

  if (error) {
    if (error.code === 'P0001') {
      const message = error.message.includes('Terlalu banyak')
        ? 'Terlalu banyak pesanan. Coba lagi nanti.'
        : 'Pre-order sedang ditutup.';
      return json({ error: message }, 429);
    }
    return json({ error: 'Pesanan belum dapat disimpan. Coba lagi.' }, 500);
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.order_id) return json({ error: 'Pesanan belum dapat dikonfirmasi. Coba lagi.' }, 502);
  return json({ orderId: result.order_id }, 200);
}
