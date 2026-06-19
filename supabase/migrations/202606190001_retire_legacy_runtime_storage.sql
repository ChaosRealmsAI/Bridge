-- Retire the pre-relay runtime/job storage model without deleting historical rows.
-- Bridge Cloud no longer writes or serves jobs/cap tokens; relay envelopes are the
-- active storage contract. Existing data is preserved under explicit retired names
-- so a later operator-approved cleanup can export/drop it.

do $$
begin
  if to_regclass('public.bridge_job_events') is not null
     and to_regclass('public.bridge_legacy_job_events_retired_20260619') is null then
    alter table public.bridge_job_events
      rename to bridge_legacy_job_events_retired_20260619;
  end if;

  if to_regclass('public.bridge_cap_token_jti') is not null
     and to_regclass('public.bridge_legacy_cap_token_jti_retired_20260619') is null then
    alter table public.bridge_cap_token_jti
      rename to bridge_legacy_cap_token_jti_retired_20260619;
  end if;

  if to_regclass('public.bridge_jobs') is not null
     and to_regclass('public.bridge_legacy_jobs_retired_20260619') is null then
    alter table public.bridge_jobs
      rename to bridge_legacy_jobs_retired_20260619;
  end if;

  if to_regclass('public.bridge_legacy_jobs_retired_20260619') is not null then
    comment on table public.bridge_legacy_jobs_retired_20260619 is
      'Retired Bridge job/runtime table. Preserved for operator-approved export or later cleanup; active APIs use bridge_relay_envelopes.';
  end if;

  if to_regclass('public.bridge_legacy_job_events_retired_20260619') is not null then
    comment on table public.bridge_legacy_job_events_retired_20260619 is
      'Retired Bridge job event table. Preserved for operator-approved export or later cleanup; active APIs use bridge_relay_envelopes.';
  end if;

  if to_regclass('public.bridge_legacy_cap_token_jti_retired_20260619') is not null then
    comment on table public.bridge_legacy_cap_token_jti_retired_20260619 is
      'Retired Bridge cap-token replay table. Preserved for operator-approved export or later cleanup; active APIs use relay authorization and key bootstrap.';
  end if;
end $$;
