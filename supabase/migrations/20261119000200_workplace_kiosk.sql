begin;

alter table public.kiosk_devices add column expires_at timestamptz;

create table timesheet_private.employee_pins (
  organisation_id uuid not null,
  employee_id uuid primary key,
  verifier text not null check (verifier ~ '^[0-9a-f]{64}$'),
  revision uuid not null default gen_random_uuid(),
  unique (organisation_id, verifier),
  foreign key (organisation_id, employee_id) references public.employees (organisation_id, id)
);

-- One bounded row per device, including its current PIN-entry challenge,
-- attempt budget and at most one short-lived, single-use attendance intent.
create table timesheet_private.kiosk_credentials (
  device_id uuid primary key references public.kiosk_devices,
  digest text not null unique check (digest ~ '^[0-9a-f]{64}$'),
  challenge uuid not null default gen_random_uuid(),
  failures integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  ticket_digest text,
  ticket_until timestamptz,
  pin_revision uuid,
  employee_id uuid,
  last_session uuid,
  clock_out boolean
);
alter table timesheet_private.employee_pins enable row level security;
alter table timesheet_private.kiosk_credentials enable row level security;
revoke all on timesheet_private.employee_pins, timesheet_private.kiosk_credentials
  from public, anon, authenticated, service_role;
create index work_sessions_employee_latest_idx on public.work_sessions (employee_id, started_at desc);

create function public.assign_employee_pin(org uuid, employee uuid, pin_verifier text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then
    raise insufficient_privilege;
  end if;
  perform 1 from public.employees where id = employee and organisation_id = org and active for update;
  if not found then raise exception 'Employee unavailable'; end if;
  insert into timesheet_private.employee_pins as p (organisation_id, employee_id, verifier)
    values (org, employee, pin_verifier)
    on conflict (employee_id) do update set verifier = excluded.verifier, revision = gen_random_uuid();
end $$;

create function public.activate_kiosk(org uuid, device_name text, credential_digest text, previous_digest text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare device uuid;
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if length(trim(device_name)) not between 1 and 80 then raise exception 'Invalid device name'; end if;
  -- Retire the previous registration when the same browser renews in this workplace.
  update public.kiosk_devices d set revoked_at = clock_timestamp()
    from timesheet_private.kiosk_credentials k where k.device_id = d.id and k.digest = previous_digest
    and d.organisation_id = org and d.revoked_at is null;
  insert into public.kiosk_devices (organisation_id, name, activated_at, expires_at)
    values (org, trim(device_name), now(), now() + interval '30 days') returning id into device;
  insert into timesheet_private.kiosk_credentials (device_id, digest) values (device, credential_digest);
end $$;

create function public.revoke_kiosk(org uuid, device uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  update public.kiosk_devices set revoked_at = coalesce(revoked_at, clock_timestamp())
    where id = device and organisation_id = org and activated_at is not null;
  if not found then raise exception 'Device unavailable'; end if;
end $$;

create function public.kiosk_context(credential_digest text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org', o.id, 'name', d.name, 'zone', o.timezone,
    'challenge', k.challenge, 'locked', k.locked_until > now())
  from timesheet_private.kiosk_credentials k
  join public.kiosk_devices d on d.id = k.device_id
  join public.organisations o on o.id = d.organisation_id
  where k.digest = credential_digest and d.revoked_at is null and d.expires_at > now()
$$;

-- All writes acquire the device lock before the credential and employee locks.
-- Revocation updates the same device row, giving it a defined commit order.
create function timesheet_private.lock_device(credential_digest text)
returns public.kiosk_devices language sql volatile set search_path = '' as $$
  select d.* from public.kiosk_devices d
  join timesheet_private.kiosk_credentials k on k.device_id = d.id
  where k.digest = credential_digest and d.revoked_at is null and d.expires_at > clock_timestamp()
  for update of d
$$;

create function public.verify_kiosk_pin(credential_digest text, attempt uuid, pin_verifier text, ticket_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device public.kiosk_devices;
  cred timesheet_private.kiosk_credentials;
  employee public.employees;
  revision_id uuid;
  latest public.work_sessions;
  failure_count integer;
  stamp timestamptz;
  next_challenge uuid := gen_random_uuid();
  working boolean;
begin
  device := timesheet_private.lock_device(credential_digest);
  if device.id is null then return jsonb_build_object('status','unauthorised'); end if;
  select * into strict cred from timesheet_private.kiosk_credentials where device_id = device.id;
  stamp := clock_timestamp();
  if cred.locked_until > stamp then return jsonb_build_object('status','locked'); end if;
  if attempt is distinct from cred.challenge or ticket_hash is null or ticket_hash !~ '^[0-9a-f]{64}$'
    then return jsonb_build_object('status','stale'); end if;
  update timesheet_private.kiosk_credentials set challenge = next_challenge, ticket_digest = null
    where device_id = device.id;

  select e.* into employee from public.employees e join timesheet_private.employee_pins p on p.employee_id = e.id
    where p.organisation_id = device.organisation_id and p.verifier = pin_verifier and e.active
    for update of e;
  -- Re-read after acquiring the employee lock in case of a concurrent PIN reset.
  select revision into revision_id from timesheet_private.employee_pins
    where employee_id = employee.id and verifier = pin_verifier;
  if revision_id is null then
    failure_count := case when cred.window_start <= stamp - interval '10 minutes' then 1 else cred.failures + 1 end;
    update timesheet_private.kiosk_credentials set
      failures = failure_count,
      window_start = case when failure_count = 1 then stamp else cred.window_start end,
      locked_until = case when failure_count >= 5 then stamp + interval '10 minutes' end
      where device_id = device.id;
    return jsonb_build_object('status',case when failure_count >= 5 then 'locked' else 'invalid' end, 'challenge',next_challenge);
  end if;
  select * into latest from public.work_sessions where employee_id = employee.id order by started_at desc limit 1;
  working := latest.id is not null and latest.ended_at is null;
  update timesheet_private.kiosk_credentials set ticket_digest = ticket_hash,
    ticket_until = clock_timestamp() + interval '45 seconds', pin_revision = revision_id,
    employee_id = employee.id, last_session = latest.id, clock_out = working
    where device_id = device.id;
  return jsonb_build_object('status','ready','firstName',split_part(trim(employee.display_name),' ',1),
    'action',case when working then 'out' else 'in' end);
end $$;

create function public.record_kiosk_attendance(credential_digest text, ticket_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device public.kiosk_devices;
  cred timesheet_private.kiosk_credentials;
  latest public.work_sessions;
  recorded timestamptz;
begin
  device := timesheet_private.lock_device(credential_digest);
  if device.id is null then return jsonb_build_object('status','unauthorised'); end if;
  select * into strict cred from timesheet_private.kiosk_credentials where device_id = device.id;
  if cred.ticket_digest is null or cred.ticket_digest is distinct from ticket_hash then
    return jsonb_build_object('status','stale');
  end if;
  update timesheet_private.kiosk_credentials set ticket_digest = null where device_id = device.id;
  perform 1 from public.employees where id = cred.employee_id and organisation_id = device.organisation_id
    and active for update;
  if not found or not exists (select 1 from timesheet_private.employee_pins
      where employee_id = cred.employee_id and revision = cred.pin_revision)
    then return jsonb_build_object('status','stale'); end if;

  select * into latest from public.work_sessions where employee_id = cred.employee_id order by started_at desc limit 1;
  recorded := clock_timestamp();
  if recorded >= cred.ticket_until or recorded >= device.expires_at
    or latest.id is distinct from cred.last_session
    or cred.clock_out is distinct from (latest.id is not null and latest.ended_at is null)
    then return jsonb_build_object('status','stale'); end if;
  if cred.clock_out then
    update public.work_sessions set ended_at = recorded, clock_out_device_id = device.id
      where id = latest.id and organisation_id = device.organisation_id and ended_at is null and started_at < recorded;
    if not found then return jsonb_build_object('status','stale'); end if;
  else
    begin
      insert into public.work_sessions (organisation_id, employee_id, started_at, clock_in_device_id)
        values (device.organisation_id, cred.employee_id, recorded, device.id);
    exception when exclusion_violation then return jsonb_build_object('status','stale'); end;
  end if;
  return jsonb_build_object('status','recorded','at',recorded,'action',case when cred.clock_out then 'out' else 'in' end);
end $$;

revoke all on function timesheet_private.lock_device(text),
  public.assign_employee_pin(uuid,uuid,text), public.activate_kiosk(uuid,text,text,text), public.revoke_kiosk(uuid,uuid),
  public.kiosk_context(text), public.verify_kiosk_pin(text,uuid,text,text), public.record_kiosk_attendance(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.assign_employee_pin(uuid,uuid,text), public.activate_kiosk(uuid,text,text,text),
  public.revoke_kiosk(uuid,uuid) to authenticated;
grant execute on function public.kiosk_context(text), public.verify_kiosk_pin(text,uuid,text,text),
  public.record_kiosk_attendance(text,text) to service_role;
commit;
