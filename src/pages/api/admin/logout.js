import { getAdminSession } from '../../../lib/admin-runtime.js';
import { adminLogoutResponse, isAllowedOrigin } from '../../../lib/admin-session.js';

export const prerender = false;

const jsonHeaders = () => ({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
});

export async function POST({ request }) {
  if (!isAllowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin tidak diizinkan.' }), { status: 403, headers: jsonHeaders() });
  }

  return adminLogoutResponse({
    cookieHeader: request.headers.get('cookie') || '',
    session: getAdminSession(),
    secure: import.meta.env.PROD,
  });
}
