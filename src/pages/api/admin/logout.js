import { getAdminSession } from '../../../lib/admin-runtime.js';
import {
  ADMIN_COOKIE_ACCESS,
  ADMIN_COOKIE_REFRESH,
  clearCookie,
  isAllowedOrigin,
  parseCookies,
} from '../../../lib/admin-session.js';

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

  const cookies = parseCookies(request.headers.get('cookie') || '');
  const admin = getAdminSession();
  await admin.logout({
    accessToken: cookies[ADMIN_COOKIE_ACCESS],
    refreshToken: cookies[ADMIN_COOKIE_REFRESH],
  });

  const headers = new Headers();
  headers.append('set-cookie', clearCookie(ADMIN_COOKIE_ACCESS, { secure: import.meta.env.PROD }));
  headers.append('set-cookie', clearCookie(ADMIN_COOKIE_REFRESH, { secure: import.meta.env.PROD }));
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
