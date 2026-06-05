alter table public.bridge_devices
  add column if not exists install_id_hash text,
  add column if not exists install_id_bound_at timestamptz;

create index if not exists bridge_devices_install_id_hash_idx
  on public.bridge_devices(install_id_hash)
  where install_id_hash is not null;
