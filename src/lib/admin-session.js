import { createHmac } from 'node:crypto';
import { createClient as supabaseCreateClient } from '@supabase/supabase-js';

export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const ADMIN_COOKIE_ACCESS = 'hot_admin_at';
export const ADMIN_COOKIE_REFRESH = 'hot_admin_rt';
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_SECONDS = 600;
export const LOGIN_PRUNE_SECONDS = 86400;

export function hmac(secret, value) {
  return createHmac('sha256', secret).update(String(value)).digest('hex');
}

export function hashIp(ip, secret) {
  return hmac(secret, `ip:${ip}`);
}

export function hashEmail(email, secret) {
  return hmac(secret, `email:${String(email).trim().toLowerCase()}`);
}

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge = ADMIN_SESSION_TTL_SECONDS, path = '/', secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}

export function isAllowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Single-flight refresh within this process: parallel requests that carry the
// same refresh token await one shared promise instead of each consuming a
// rotation. Serverless can still run several instances, so this is a
// deduplication layer, not a global lock.
const refreshInflight = new Map();

function refreshOnce({ refreshToken, supabaseUrl, supabaseAnonKey, createClient }) {
  const existing = refreshInflight.get(refreshToken);
  if (existing) return existing;
  const auth = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const promise = auth.auth.refreshSession({ refresh_token: refreshToken })
    .catch(() => ({ data: {}, error: new Error('refresh failed') }))
    .finally(() => { refreshInflight.delete(refreshToken); });
  refreshInflight.set(refreshToken, promise);
  return promise;
}

export function createAdminSession({
  supabaseUrl,
  supabaseAnonKey,
  serviceKey,
  secure = false,
  createClient = supabaseCreateClient,
  loadAdmin,
} = {}) {
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const fetchAdmin = loadAdmin ?? (async (userId) => {
    const { data, error } = await service
      .from('admin_users')
      .select('user_id, nama, aktif')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data || !data.aktif) return null;
    return { userId: data.user_id, nama: data.nama };
  });

  const authClient = () => createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  async function resolve({ cookieHeader = '' } = {}) {
    const cookies = parseCookies(cookieHeader);
    const accessToken = cookies[ADMIN_COOKIE_ACCESS];
    const refreshToken = cookies[ADMIN_COOKIE_REFRESH];
    if (!accessToken || !refreshToken) return { admin: null };

    let result = await authClient().auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    let user = result.data?.user ?? null;
    let session = result.data?.session ?? null;

    if (!user) {
      result = await refreshOnce({ refreshToken, supabaseUrl, supabaseAnonKey, createClient });
      user = result.data?.user ?? null;
      session = result.data?.session ?? null;
    }

    if (!user) return { admin: null };

    const admin = await fetchAdmin(user.id);
    if (!admin) return { admin: null };

    return { admin, user, session };
  }

  async function login({ email, password }) {
    const { data, error } = await authClient().auth.signInWithPassword({ email, password });
    if (error || !data?.session) return { session: null };
    return { session: data.session };
  }

  async function logout({ accessToken, refreshToken }) {
    try {
      const auth = authClient();
      await auth.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      await auth.auth.signOut();
    } catch {
      // Best effort: the cookies are cleared by the caller regardless.
    }
    return { ok: true };
  }

  async function checkLoginRateLimit({ ipHash, emailHash }) {
    const since = new Date(Date.now() - LOGIN_WINDOW_SECONDS * 1000).toISOString();
    const [ip, email] = await Promise.all([
      service.from('admin_login_attempts').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', since),
      service.from('admin_login_attempts').select('id', { count: 'exact', head: true }).eq('email_hash', emailHash).gte('created_at', since),
    ]);
    const ipCount = ip.count ?? 0;
    const emailCount = email.count ?? 0;
    return { allowed: ipCount < LOGIN_MAX_ATTEMPTS && emailCount < LOGIN_MAX_ATTEMPTS, ipCount, emailCount };
  }

  async function recordFailedLogin({ ipHash, emailHash }) {
    await service.from('admin_login_attempts').insert({ ip_hash: ipHash, email_hash: emailHash });
    const before = new Date(Date.now() - LOGIN_PRUNE_SECONDS * 1000).toISOString();
    await service.from('admin_login_attempts').delete().lt('created_at', before);
    return { ok: true };
  }

  return { service, resolve, login, logout, checkLoginRateLimit, recordFailedLogin, fetchAdmin };
}
