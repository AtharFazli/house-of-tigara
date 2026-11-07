import { adminJson, requireAdmin, unauthorized } from '../../../../lib/admin-runtime.js';
import { assertOrderId, getOrderDetail } from '../../../../lib/admin-orders.js';

export const prerender = false;

export async function GET({ request, params }) {
  const { admin, session, service } = await requireAdmin(request);
  if (!admin) return unauthorized();

  try {
    assertOrderId(params.id);
  } catch {
    return adminJson({ error: 'Order ID tidak valid.' }, 400);
  }

  const order = await getOrderDetail(service, params.id);
  if (!order) return adminJson({ error: 'Order tidak ditemukan.' }, 404);
  return adminJson({ order }, 200, session);
}
