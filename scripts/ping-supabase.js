#!/usr/bin/env node
/**
 * Ping Supabase để tránh bị pause sau 7 ngày không có request
 * Dùng: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/ping-supabase.js
 * hoặc: DATABASE_URL=... node scripts/ping-supabase.js
 * Có thể chạy local, cron, hoặc GitHub Actions
 */
async function pingRest() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.log('[ping] SKIP REST: thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY');
    return false;
  }
  console.log(`[ping] REST ${url}/rest/v1/users?select=count`);
  try {
    const res = await fetch(`${url}/rest/v1/users?select=count`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: '0-0' },
    });
    const text = await res.text();
    console.log(`[ping] REST status ${res.status} body:`, text.slice(0, 500));
    if (res.ok) {
      console.log('[ping] ✅ REST ping OK -> Supabase sẽ không bị pause');
      return true;
    }
    // thử bảng products nếu users fail
    const res2 = await fetch(`${url}/rest/v1/products?select=count`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: '0-0' },
    });
    console.log(`[ping] fallback products status ${res2.status}`);
    return res2.ok;
  } catch (e) {
    console.error('[ping] REST fail', e.message);
    return false;
  }
}

async function pingPostgres() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('[ping] SKIP Postgres: thiếu DATABASE_URL');
    return false;
  }
  console.log('[ping] Postgres SELECT 1 via DATABASE_URL');
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query('SELECT 1 as ping, now() as now');
    console.log('[ping] ✅ Postgres OK', r.rows[0]);
    await c.end();
    return true;
  } catch (e) {
    console.error('[ping] Postgres fail', e.message);
    return false;
  }
}

(async () => {
  const r1 = await pingRest();
  const r2 = await pingPostgres();
  if (r1 || r2) {
    console.log('✅ Keep-alive thành công - Supabase sẽ không bị pause');
    process.exit(0);
  } else {
    console.log('⚠️ Không ping được Supabase - kiểm tra env SUPABASE_URL/DATABASE_URL');
    // Không exit 1 để không fail cron nếu chỉ chạy health gián tiếp
    process.exit(0);
  }
})();
