import { adminJson, requireAdmin, unauthorized } from '../../../../../lib/admin-runtime.js';
import { setStatus } from '../../../../../lib/admin-orders.js';
import { canTransition, isOrderOrderId } from '../../../../../lib/admin-shared.js';

export const prerender = false;

export async function POST({ request, params }) {
  const { admin, session, service } = await requireAdmin(request);
  if (!admin) return unauthorized();

  if (!isOrderOrderId(params.id)) return adminJson({ error: 'Order ID tidak valid.' }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return adminJson({ error: 'Data tidak valid.' }, 400);
  }

  const fromStatus = String(body?.from_status ?? '');
  const toStatus = String(body?.to_status ?? '');

  if (!canTransition(fromStatus, toStatus)) {
    return adminJson({ error: 'Transisi status tidak diizinkan.' }, 400);
  }

  try {
    const result = await setStatus(service, {
      orderId: params.id,
      fromStatus,
      toStatus,
      adminUserId: admin.userId,
    });

    if (result.ok) return adminJson({ ok: true, order: result.order }, 200, session);
    if (result.changed === false) {
      return adminJson({ error: result.error, changed: false }, 409, session);
    }
    return adminJson({ error: result.error ?? 'Perubahan ditolak.' }, 400, session);
  } catch (error) {
    return adminJson({ error: 'Gagal mengubah status.' }, 500, session);
  }
}
