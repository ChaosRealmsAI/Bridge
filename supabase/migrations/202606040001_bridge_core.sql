create extension if not exists pgcrypto;

create table if not exists public.bridge_users (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists public.bridge_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bridge_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  device_name text not null,
  status text not null default 'online' check (status in ('online', 'offline', 'revoked')),
  app_version text,
  capabilities jsonb not null default '{}'::jsonb,
  local_state jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bridge_device_tokens (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.bridge_devices(id) on delete cascade,
  token_hash text not null unique,
  scope jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bridge_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  device_id uuid references public.bridge_devices(id) on delete set null,
  device_name text,
  code_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.bridge_session_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.bridge_connect_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  device_id uuid references public.bridge_devices(id) on delete set null,
  product_id text not null,
  device_name text,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.bridge_authorizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  device_id uuid not null references public.bridge_devices(id) on delete cascade,
  product_id text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_id, product_id)
);

create table if not exists public.bridge_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  device_id uuid not null references public.bridge_devices(id) on delete cascade,
  product_id text not null,
  kind text not null check (kind in ('codex.chat', 'codex.run', 'codex.rpc')),
  runtime text not null default 'codex_app_server',
  workspace_ref text not null default 'default',
  input jsonb not null default '{}'::jsonb,
  policy jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  result jsonb not null default '{}'::jsonb,
  request_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  acked_at timestamptz
);

create unique index if not exists bridge_jobs_request_key_idx
  on public.bridge_jobs(user_id, device_id, product_id, request_key)
  where request_key is not null;

create table if not exists public.bridge_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.bridge_jobs(id) on delete cascade,
  seq integer not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (job_id, seq)
);

create table if not exists public.bridge_audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.bridge_users(id) on delete set null,
  device_id uuid references public.bridge_devices(id) on delete set null,
  product_id text,
  action text not null,
  target_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bridge_devices_user_status_idx on public.bridge_devices(user_id, status, last_seen_at desc);
create index if not exists bridge_session_links_token_idx on public.bridge_session_links(token_hash);
create index if not exists bridge_connect_intents_token_idx on public.bridge_connect_intents(token_hash);
create index if not exists bridge_jobs_user_created_idx on public.bridge_jobs(user_id, created_at desc);
create index if not exists bridge_jobs_device_status_idx on public.bridge_jobs(device_id, status, created_at asc);
create index if not exists bridge_job_events_job_seq_idx on public.bridge_job_events(job_id, seq asc);
