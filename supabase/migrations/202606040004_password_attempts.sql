create table if not exists public.bridge_password_attempts (
  identifier text primary key,
  failed_count integer not null default 0,
  locked_until timestamptz,
  last_failed_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists bridge_password_attempts_locked_idx
  on public.bridge_password_attempts(locked_until)
  where locked_until is not null;
