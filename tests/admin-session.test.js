import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_COOKIE_ACCESS,
  ADMIN_COOKIE_REFRESH,
  adminLogoutResponse,
  createAdminSession,
  hashEmail,
  hashIp,
  isAllowedOrigin,
  parseCookies,
  serializeCookie,
  clearCookie,
} from '../src/lib/admin-session.js';

const SECRET = 'test-secret';
const COOKIE = `${ADMIN_COOKIE_ACCESS}=at; ${ADMIN_COOKIE_REFRESH}=rt`;

function fakeQuery(result) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    lt: () => chain,
    order: () => chain,
    maybeSingle: async () => result,
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

function stub({ auth = {}, count = 0 } = {}) {
  const calls = { refresh: 0, inserts: 0 };
  const client = {
    auth: {
      setSession: auth.setSession ?? (async () => ({
        data: { user: { id: 'u1' }, session: { access_token: 'at', refresh_token: 'rt' } },
        error: null,
      })),
      refreshSession: auth.refreshSession ?? (async () => {
        calls.refresh += 1;
        return { data: {}, error: new Error('no refresh') };
      }),
      signInWithPassword: auth.signInWithPassword ?? (async () => ({ data: null, error: new Error('no') })),
      signOut: auth.signOut ?? (async () => ({})),
    },
    from: () => fakeQuery({ count, error: null }),
  };
  const createClient = () => client;
  return { client, calls, createClient };
}

function session(overrides = {}) {
  return createAdminSession({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon',
    serviceKey: 'service',
    secure: false,
    ...overrides,
  });
}

test('cookies round-trip and clear', () => {
  const serialized = serializeCookie('a', 'b c', { maxAge: 60, secure: true });
  assert.match(serialized, /^a=b%20c;/);
  assert.match(serialized, /HttpOnly/);
  assert.match(serialized, /SameSite=Strict/);
  assert.match(serialized, /Secure/);
  assert.match(serialized, /Max-Age=60/);
  assert.deepEqual(parseCookies('a=b%20c'), { a: 'b c' });
  assert.match(clearCookie('a'), /Max-Age=0/);
});

test('logout clears both cookies when there is no session client', async () => {
  const response = await adminLogoutResponse({
    cookieHeader: `${ADMIN_COOKIE_ACCESS}=at; ${ADMIN_COOKIE_REFRESH}=rt`,
    session: null,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], new RegExp(`^${ADMIN_COOKIE_ACCESS}=;`));
  assert.match(cookies[0], /Max-Age=0/);
  assert.match(cookies[1], new RegExp(`^${ADMIN_COOKIE_REFRESH}=;`));
  assert.match(cookies[1], /Max-Age=0/);
});

test('logout revokes the session when a client is present', async () => {
  let revoked = null;
  const response = await adminLogoutResponse({
    cookieHeader: `${ADMIN_COOKIE_ACCESS}=at; ${ADMIN_COOKIE_REFRESH}=rt`,
    session: { logout: async (tokens) => { revoked = tokens; } },
  });
  assert.deepEqual(revoked, { accessToken: 'at', refreshToken: 'rt' });
  assert.equal(response.status, 200);
});

test('hashEmail normalizes and is distinct from hashIp', () => {
  assert.equal(hashEmail('Ana@Example.com', SECRET), hashEmail('  ana@example.com  ', SECRET));
  assert.notEqual(hashEmail('ana@example.com', SECRET), hashEmail('budi@example.com', SECRET));
  assert.notEqual(hashIp('10.0.0.1', SECRET), hashEmail('ana@example.com', SECRET));
  assert.match(hashEmail('ana@example.com', SECRET), /^[0-9a-f]{64}$/);
});

test('resolve rejects a request without cookies', async () => {
  const admin = session({ createClient: stub().createClient });
  assert.equal((await admin.resolve({ cookieHeader: '' })).admin, null);
});

test('resolve treats a malformed cookie value as no session', async () => {
  const admin = session({ createClient: stub().createClient, loadAdmin: async () => ({ userId: 'u1', nama: 'Ana' }) });
  const result = await admin.resolve({ cookieHeader: `${ADMIN_COOKIE_ACCESS}=%` });
  assert.equal(result.admin, null);
});

test('resolve rejects a user that is not an active admin', async () => {
  const admin = session({ createClient: stub().createClient, loadAdmin: async () => null });
  assert.equal((await admin.resolve({ cookieHeader: COOKIE })).admin, null);
});

test('resolve returns the admin for a valid session', async () => {
  const admin = session({ createClient: stub().createClient, loadAdmin: async () => ({ userId: 'u1', nama: 'Ana' }) });
  const result = await admin.resolve({ cookieHeader: COOKIE });
  assert.deepEqual(result.admin, { userId: 'u1', nama: 'Ana' });
  assert.equal(result.session.access_token, 'at');
});

test('resolve refreshes once when the access token is expired', async () => {
  const stubs = stub({
    auth: {
      setSession: async () => ({ data: {}, error: new Error('expired') }),
      refreshSession: async () => {
        stubs.calls.refresh += 1;
        return {
          data: { user: { id: 'u1' }, session: { access_token: 'at2', refresh_token: 'rt2' } },
          error: null,
        };
      },
    },
  });
  const admin = session({ createClient: stubs.createClient, loadAdmin: async () => ({ userId: 'u1', nama: 'Ana' }) });
  const result = await admin.resolve({ cookieHeader: COOKIE });
  assert.equal(result.admin.nama, 'Ana');
  assert.equal(result.session.access_token, 'at2');
  assert.equal(stubs.calls.refresh, 1);
});

test('parallel requests share one refresh (single flight)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stubs = stub({
    auth: {
      setSession: async () => ({ data: {}, error: new Error('expired') }),
      refreshSession: async () => {
        stubs.calls.refresh += 1;
        await gate;
        return { data: { user: { id: 'u1' }, session: { access_token: 'at2', refresh_token: 'rt2' } }, error: null };
      },
    },
  });
  const admin = session({ createClient: stubs.createClient, loadAdmin: async () => ({ userId: 'u1', nama: 'Ana' }) });
  const pending = Promise.all([
    admin.resolve({ cookieHeader: COOKIE }),
    admin.resolve({ cookieHeader: COOKIE }),
    admin.resolve({ cookieHeader: COOKIE }),
  ]);
  release();
  const results = await pending;
  assert.equal(stubs.calls.refresh, 1);
  assert.ok(results.every((result) => result.admin?.nama === 'Ana'));
});

test('login rate limit counts per ip_hash and per email_hash', async () => {
  const low = session({ createClient: stub({ count: 4 }).createClient });
  assert.equal((await low.checkLoginRateLimit({ ipHash: 'a', emailHash: 'b' })).allowed, true);

  const byIp = session({ createClient: stub({ count: 5 }).createClient });
  assert.equal((await byIp.checkLoginRateLimit({ ipHash: 'a', emailHash: 'b' })).allowed, false);
});

test('login rejects a disallowed cross-origin POST', () => {
  const request = { headers: new Headers({ origin: 'https://evil.example', host: 'shop.test' }) };
  assert.equal(isAllowedOrigin(request), false);
  assert.equal(isAllowedOrigin({ headers: new Headers({ host: 'shop.test' }) }), true);
  assert.equal(isAllowedOrigin({ headers: new Headers({ origin: 'https://shop.test', host: 'shop.test' }) }), true);
});
