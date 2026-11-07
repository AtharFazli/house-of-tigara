import { defineConfig, envField } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'server',
  adapter: vercel(),
  server: { host: true },
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: 'server', access: 'secret' }),
      SUPABASE_SECRET_KEY: envField.string({ context: 'server', access: 'secret' }),
      ORDER_HASH_SECRET: envField.string({ context: 'server', access: 'secret' }),
    },
  },
});
