alter table public.bridge_users
  add column if not exists password_hash text,
  add column if not exists password_salt text,
  add column if not exists password_iterations integer,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists bridge_users_email_unique_idx
  on public.bridge_users(lower(email))
  where email is not null;
