import { adminJson, requireAdmin, unauthorized } from '../../../lib/admin-runtime.js';
import { getCounts, listOrders } from '../../../lib/admin-orders.js';

export const prerender = false;

// POST is used for search so a buyer's name never lands in a URL or in the
// server logs. The list never returns the WhatsApp number.
export async function POST({ request }) {
  const { admin, session, service } = await requireAdmin(request);
  if (!admin) return unauthorized();

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const status = String(body?.status ?? '');
  const q = String(body?.q ?? '').trim();

  const [counts, orders] = await Promise.all([
    getCounts(service),
    listOrders(service, { status, q }),
  ]);
  return adminJson({ counts, orders }, 200, session);
}

export async function GET({ request }) {
  const { admin, session, service } = await requireAdmin(request);
  if (!admin) return unauthorized();
  const [counts, orders] = await Promise.all([getCounts(service), listOrders(service)]);
  return adminJson({ counts, orders }, 200, session);
}
