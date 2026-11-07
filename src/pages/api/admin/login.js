import { getAdminSession, orderHashSecret } from '../../../lib/admin-runtime.js';
import { hashEmail, hashIp, isAllowedOrigin, sessionCookieHeaders } from '../../../lib/admin-session.js';

export const prerender = false;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
  },
});

export async function POST({ request, clientAddress }) {
  if (!isAllowedOrigin(request)) return json({ error: 'Origin tidak diizinkan.' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Data tidak valid.' }, 400);
  }

  const email = String(body?.email ?? '').trim().toLowerCase();
  const secretInput = String(body?.secret ?? '');
  if (!email || !secretInput) return json({ error: 'Email dan password wajib diisi.' }, 400);

  const admin = getAdminSession();
  if (!admin) return json({ error: 'Layanan admin belum dikonfigurasi.' }, 503);
  const ipHash = hashIp(clientAddress || '', orderHashSecret);
  const emailHash = hashEmail(email, orderHashSecret);

  // Only failures are counted, and both the IP and the email hash are limited
  // so one person on a shared wifi cannot be locked out by someone else.
  const rate = await admin.checkLoginRateLimit({ ipHash, emailHash });
  if (!rate.allowed) {
    return json({ error: 'Terlalu banyak percobaan gagal. Coba lagi nanti.' }, 429);
  }

  const result = await admin.login({ email, password: secretInput });
  if (!result.session) {
    await admin.recordFailedLogin({ ipHash, emailHash });
    return json({ error: 'Email atau password salah.' }, 401);
  }

  const profile = await admin.fetchAdmin(result.session.user.id);
  if (!profile) return json({ error: 'Akun ini bukan anggota admin.' }, 403);

  const headers = sessionCookieHeaders(result.session, { secure: import.meta.env.PROD });
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex');
  return new Response(JSON.stringify({ ok: true, admin: profile }), { status: 200, headers });
}
