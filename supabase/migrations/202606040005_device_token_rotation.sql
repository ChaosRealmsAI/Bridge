alter table public.bridge_device_tokens
  add column if not exists last_used_at timestamptz,
  add column if not exists revoked_at timestamptz;

create index if not exists bridge_device_tokens_device_active_idx
  on public.bridge_device_tokens(device_id, expires_at desc)
  where revoked_at is null;
