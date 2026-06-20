alter table public.bridge_connect_intents
  add column if not exists policy jsonb not null default '{}'::jsonb;

create index if not exists bridge_connect_intents_product_policy_idx
  on public.bridge_connect_intents(product_id, created_at desc);
