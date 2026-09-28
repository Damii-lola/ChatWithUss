-- =====================================================================
-- ChatWithUss — Supabase schema
-- Idempotent: safe to run on a fresh project AND on top of the earlier
-- version of this schema. Paste into Supabase → SQL Editor → Run.
-- =====================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ============ SHOPS ============
create table if not exists shops (
  id uuid primary key default gen_random_uuid(),
  shop_domain text unique not null,
  access_token_enc text,
  scopes text,
  plan text not null default 'trial',
  billing_status text not null default 'none',
  subscription_id text,
  shop_name text,
  email text,
  currency text,
  settings jsonb not null default '{}'::jsonb,
  installed_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Expiring offline tokens (mandatory for new public apps since April 2026)
alter table shops add column if not exists access_token_expires_at timestamptz;
alter table shops add column if not exists refresh_token_enc text;
alter table shops add column if not exists refresh_token_expires_at timestamptz;
alter table shops add column if not exists primary_domain text;
alter table shops add column if not exists shopify_shop_id text;
alter table shops add column if not exists brand_synced_at timestamptz;
alter table shops add column if not exists trial_ends_at timestamptz;

-- Settings default lives in the app (server/src/lib/settings.js); column stays a plain jsonb bag.
alter table shops alter column settings set default '{}'::jsonb;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists shops_set_updated_at on shops;
create trigger shops_set_updated_at before update on shops
  for each row execute function set_updated_at();

-- ============ CONVERSATIONS ============
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  visitor_id text not null,
  customer_email text,
  customer_name text,
  shopify_customer_id text,
  order_id text,
  status text not null default 'open' check (status in ('open','pending','resolved')),
  resolved_by text check (resolved_by in ('ai','self_service','agent')),
  needs_human boolean not null default false,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists conversations_shop_status_idx on conversations (shop_id, status, last_message_at desc);
create index if not exists conversations_visitor_idx on conversations (shop_id, visitor_id);
create index if not exists conversations_email_idx on conversations (shop_id, lower(customer_email));

-- ============ MESSAGES ============
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender text not null check (sender in ('customer','ai','agent','system')),
  body text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages (conversation_id, created_at);

-- ============ RETURNS ============
create table if not exists return_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  order_id text not null,
  order_name text not null,
  customer_email text not null,
  items jsonb not null,
  reason text not null,
  note text,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  shopify_return_id text,
  decline_reason text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists return_requests_shop_status_idx on return_requests (shop_id, status, created_at desc);
create index if not exists return_requests_email_idx on return_requests (shop_id, lower(customer_email));

-- ============ AI KNOWLEDGE (mistral-embed = 1024 dims) ============
create table if not exists knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  source text not null check (source in ('policy','page','product','custom')),
  source_ref text,
  title text,
  content text not null,
  embedding vector(1024),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_chunks_shop_idx on knowledge_chunks (shop_id);
create index if not exists knowledge_chunks_embedding_idx on knowledge_chunks using hnsw (embedding vector_cosine_ops);

create or replace function match_knowledge(
  p_shop_id uuid,
  p_embedding vector(1024),
  p_count int default 5
)
returns table (id uuid, source text, title text, content text, similarity float)
language sql stable as $$
  select k.id, k.source, k.title, k.content,
         1 - (k.embedding <=> p_embedding) as similarity
  from knowledge_chunks k
  where k.shop_id = p_shop_id and k.embedding is not null
  order by k.embedding <=> p_embedding
  limit p_count;
$$;

-- ============ RESOLUTION STATS ============
create table if not exists resolution_events (
  id bigserial primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  type text not null check (type in ('tracking_lookup','return_request','ai_answer','agent_reply','order_cancel','refund','address_update')),
  created_at timestamptz not null default now()
);
create index if not exists resolution_events_shop_idx on resolution_events (shop_id, created_at desc);

-- ============ WEBHOOK IDEMPOTENCY ============
-- Shopify retries webhooks; X-Shopify-Webhook-Id lets us process each one exactly once.
create table if not exists webhook_events (
  webhook_id text primary key,
  shop_domain text not null,
  topic text not null,
  received_at timestamptz not null default now()
);
create index if not exists webhook_events_received_idx on webhook_events (received_at);

-- ============ GDPR / COMPLIANCE LOG ============
create table if not exists compliance_requests (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null,
  topic text not null check (topic in ('customers/data_request','customers/redact','shop/redact')),
  customer_email text,
  shopify_customer_id text,
  payload jsonb not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists compliance_requests_shop_idx on compliance_requests (shop_domain, created_at desc);

-- ============ LOCK IT DOWN ============
-- RLS on with zero policies = only the backend (service_role key) can read/write.
alter table shops enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table return_requests enable row level security;
alter table knowledge_chunks enable row level security;
alter table resolution_events enable row level security;
alter table webhook_events enable row level security;
alter table compliance_requests enable row level security;
