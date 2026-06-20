create table if not exists public.bridge_authorization_import_proofs (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  device_id uuid not null references public.bridge_devices(id) on delete cascade,
  product_id text not null,
  authorization_id uuid not null references public.bridge_authorizations(id) on delete cascade,
  source_origin text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists bridge_authorization_import_proofs_lookup_idx
  on public.bridge_authorization_import_proofs(product_id, user_id, device_id, expires_at asc);

create index if not exists bridge_authorization_import_proofs_consumed_idx
  on public.bridge_authorization_import_proofs(consumed_at, expires_at asc);
