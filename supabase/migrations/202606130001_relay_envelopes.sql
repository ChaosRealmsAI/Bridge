create table if not exists public.bridge_relay_envelopes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bridge_users(id) on delete cascade,
  device_id uuid not null references public.bridge_devices(id) on delete cascade,
  product_id text not null,
  channel_id text not null,
  direction text not null check (direction in ('product_to_device', 'device_to_product')),
  seq bigint not null default 0,
  request_key text,
  ciphertext text not null,
  aad text not null,
  nonce text not null,
  algorithm text not null,
  sender_key_id text not null,
  recipient_key_id text not null,
  meta jsonb not null default '{}'::jsonb,
  delivery_status text not null default 'queued' check (delivery_status in ('queued', 'delivered', 'acked', 'expired')),
  queued_at timestamptz not null default now(),
  delivered_at timestamptz,
  acked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bridge_relay_envelopes_request_key_idx
  on public.bridge_relay_envelopes(user_id, device_id, product_id, request_key)
  where request_key is not null;

create index if not exists bridge_relay_envelopes_connector_inbox_idx
  on public.bridge_relay_envelopes(user_id, device_id, direction, delivery_status, created_at asc);

create index if not exists bridge_relay_envelopes_product_inbox_idx
  on public.bridge_relay_envelopes(user_id, product_id, direction, channel_id, created_at asc);

create index if not exists bridge_relay_envelopes_expires_idx
  on public.bridge_relay_envelopes(expires_at asc);

alter table if exists public.bridge_relay_envelopes enable row level security;
