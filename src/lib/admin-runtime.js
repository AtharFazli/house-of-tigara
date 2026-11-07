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
