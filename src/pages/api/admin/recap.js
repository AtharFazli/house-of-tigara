import { adminJson, requireAdmin, unauthorized } from '../../../lib/admin-runtime.js';
import { getRecap } from '../../../lib/admin-orders.js';

export const prerender = false;

export async function GET({ request }) {
  const { admin, session, service } = await requireAdmin(request);
  if (!admin) return unauthorized();
  const recap = await getRecap(service);
  return adminJson({ recap }, 200, session);
}
