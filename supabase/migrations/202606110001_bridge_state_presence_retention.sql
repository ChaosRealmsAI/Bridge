alter table public.bridge_connect_intents
  add column if not exists token_ciphertext text;

create index if not exists bridge_connect_intents_pending_state_idx
  on public.bridge_connect_intents(user_id, product_id, expires_at desc)
  where consumed_at is null;

create index if not exists bridge_jobs_terminal_retention_idx
  on public.bridge_jobs(status, completed_at)
  where status in ('succeeded', 'failed', 'cancelled');
