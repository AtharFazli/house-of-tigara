import { ORDER_HASH_SECRET, SUPABASE_ANON_KEY, SUPABASE_SECRET_KEY, SUPABASE_URL } from 'astro:env/server';
import { createAdminSession } from './admin-session.js';

export const orderHashSecret = ORDER_HASH_SECRET;

export function getAdminSession() {
  return createAdminSession({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    serviceKey: SUPABASE_SECRET_KEY,
    secure: import.meta.env.PROD,
  });
}

// Every /admin and /api/admin/* request resolves the session on the server.
// admin is null when the cookie is missing, expired, or the user is not an
// active member of admin_users.
export async function requireAdmin(request) {
  const session = getAdminSession();
  const resolved = await session.resolve({ cookieHeader: request.headers.get('cookie') || '' });
  return { admin: resolved.admin, session: resolved.session, service: session.service };
}

// JSON responses never cache, never index, and always refresh the cookie.
export function adminJson(body, status = 200, session = null) {
  const headers = sessionCookieHeaders(session, { secure: import.meta.env.PROD });
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex');
  return new Response(JSON.stringify(body), { status, headers });
}

export const unauthorized = () => adminJson({ error: 'Belum masuk.' }, 401);
