alter table public.bridge_jobs
  add column if not exists queued_at timestamptz,
  add column if not exists pushed_at timestamptz,
  add column if not exists desktop_received_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists first_delta_at timestamptz,
  add column if not exists completed_at timestamptz;

update public.bridge_jobs
set queued_at = coalesce(queued_at, created_at)
where queued_at is null;
