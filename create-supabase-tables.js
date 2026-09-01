/**
 * Tạo bảng Supabase cho dual-mode (chạy 1 lần)
 * Cách 1: Copy SQL trong file này và paste vào Supabase Dashboard → SQL Editor → Run
 * Cách 2: Chạy local:  DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.douyekkqvytasvsoctit.supabase.co:5432/postgres node create-supabase-tables.js
 */
const sql = `
create table if not exists public.users(id uuid primary key, email text unique, username text, password_hash text, roles text[], status text, created_at timestamptz, updated_at timestamptz);
create table if not exists public.jwt_blacklist(token text primary key, created_at timestamptz default now());
create table if not exists public.products(id text primary key, name text, sku text, category jsonb, price int, stock int, images jsonb, rating float, review_count int, seller jsonb, currency text, deleted boolean);
create table if not exists public.orders(id text primary key, user_id text, items jsonb, shipping_address jsonb, total int, status text, created_at timestamptz, updated_at timestamptz);
create table if not exists public.payments(id text primary key, transaction_id text, order_id text, amount int, currency text, status text, message text, timestamp timestamptz, created_at timestamptz, idempotency_key text, refund_id text);
create table if not exists public.notifications(id bigserial primary key, event text, data jsonb, channel text, created_at timestamptz default now());
alter table public.users disable row level security;
alter table public.jwt_blacklist disable row level security;
alter table public.products disable row level security;
alter table public.orders disable row level security;
alter table public.payments disable row level security;
alter table public.notifications disable row level security;
insert into public.products values ('prod-42','ASUS VivoBook 15','ASUS-VB15-2026','{"id":3,"name":"Laptops"}',15000000,50,'["https://cdn.shop.com/prod-42-1.jpg"]',4.5,128,'{"id":"seller-7","name":"TechStore VN"}','VND',false) on conflict (id) do nothing;
insert into public.products values ('prod-17','Mouse Logitech M331','LOGI-M331','{"id":5,"name":"Accessories"}',450000,200,'["https://cdn.shop.com/prod-17.jpg"]',4.7,89,'{"id":"seller-7","name":"TechStore VN"}','VND',false) on conflict (id) do nothing;
insert into public.products values ('prod-99','iPhone 15 Pro','IP15P-256','{"id":2,"name":"Phones"}',28000000,15,'["https://cdn.shop.com/prod-99.jpg"]',4.9,312,'{"id":"seller-9","name":"Apple Store"}','VND',false) on conflict (id) do nothing;
`;

if (process.env.DATABASE_URL) {
  const { Client } = require('pg');
  (async()=>{
    const c=new Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
    try{ await c.connect(); console.log('connected'); await c.query(sql); console.log('tables created'); await c.end(); }
    catch(e){ console.error('fail',e.message); }
  })();
} else {
  console.log(sql);
  console.log('\n--- Copy SQL trên và paste vào Supabase Dashboard → SQL Editor → Run ---');
}
