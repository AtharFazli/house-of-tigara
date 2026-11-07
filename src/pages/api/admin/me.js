import { adminJson, requireAdmin, unauthorized } from '../../../lib/admin-runtime.js';

export const prerender = false;

export async function GET({ request }) {
  const { admin, session } = await requireAdmin(request);
  if (!admin) return unauthorized();
  return adminJson({ admin }, 200, session);
}
