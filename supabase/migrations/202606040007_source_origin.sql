alter table public.bridge_connect_intents
  add column if not exists source_origin text;

alter table public.bridge_authorizations
  add column if not exists source_origin text;

alter table public.bridge_jobs
  add column if not exists source_origin text;

create index if not exists bridge_jobs_user_product_source_idx
  on public.bridge_jobs(user_id, product_id, source_origin, created_at desc);

create index if not exists bridge_authorizations_user_product_source_idx
  on public.bridge_authorizations(user_id, product_id, source_origin)
  where status = 'active';
