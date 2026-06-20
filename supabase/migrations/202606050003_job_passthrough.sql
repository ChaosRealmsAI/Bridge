alter table public.bridge_jobs
  drop constraint if exists bridge_jobs_kind_check;

alter table public.bridge_jobs
  alter column workspace_ref drop default,
  alter column workspace_ref drop not null;
