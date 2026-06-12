alter table public.bridge_authorizations
  add column if not exists epoch integer not null default 1;

alter table public.bridge_jobs
  add column if not exists cap_token text;

create table if not exists public.bridge_cap_token_jti (
  id uuid primary key default gen_random_uuid(),
  jti text not null,
  job_id uuid references public.bridge_jobs(id) on delete cascade,
  product_id text not null,
  device_id uuid not null references public.bridge_devices(id) on delete cascade,
  uses integer not null default 0,
  max_uses integer not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (jti)
);

alter table if exists public.bridge_cap_token_jti enable row level security;

create index if not exists bridge_authorizations_epoch_idx
  on public.bridge_authorizations(user_id, device_id, product_id, epoch);

create index if not exists bridge_cap_token_jti_expires_idx
  on public.bridge_cap_token_jti(expires_at asc);
