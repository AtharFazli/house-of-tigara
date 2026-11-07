import { getAdminSession } from '../../../lib/admin-runtime.js';
import { sessionCookieHeaders } from '../../../lib/admin-session.js';

export const prerender = false;

export async function GET({ request }) {
  const admin = getAdminSession();
  const result = await admin.resolve({ cookieHeader: request.headers.get('cookie') || '' });

  if (!result.admin) {
    return new Response(JSON.stringify({ error: 'Belum masuk.' }), {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  }

  const headers = sessionCookieHeaders(result.session, { secure: import.meta.env.PROD });
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex');
  return new Response(JSON.stringify({ admin: result.admin }), { status: 200, headers });
}
