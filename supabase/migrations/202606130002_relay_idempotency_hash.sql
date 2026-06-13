alter table if exists public.bridge_relay_envelopes
  add column if not exists idempotency_hash text;
