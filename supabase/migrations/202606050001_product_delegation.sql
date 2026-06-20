create table if not exists public.bridge_product_delegation_nonces (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  nonce_hash text not null,
  request_timestamp timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (product_id, nonce_hash)
);

create index if not exists bridge_product_delegation_nonces_expires_idx
  on public.bridge_product_delegation_nonces(expires_at asc);
