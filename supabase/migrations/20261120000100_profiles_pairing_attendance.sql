begin;

-- Retire the Phase 2 entry points, including its unaudited PIN setter. Keep
-- historical columns/registrations and verifiers intact during the upgrade.
revoke all on function public.assign_employee_pin(uuid,uuid,text),
  public.activate_kiosk(uuid,text,text,text), public.verify_kiosk_pin(text,uuid,text,text),
  public.record_kiosk_attendance(text,text) from public, anon, authenticated, service_role;

alter table timesheet_private.employee_pins add column sealed_pin text
  check (sealed_pin ~ '^v1\.[0-9a-f]{68}$');
alter table public.kiosk_devices add column last_seen_at timestamptz;
alter table timesheet_private.kiosk_credentials add column previous_digest text,
  add column previous_until timestamptz;
create unique index kiosk_previous_digest_idx on timesheet_private.kiosk_credentials(previous_digest)
  where previous_digest is not null;

create table timesheet_private.pin_audit (
  id bigint generated always as identity primary key,
  organisation_id uuid not null, employee_id uuid not null, actor_id uuid not null,
  event text not null check (event in ('pin_changed','pin_revealed')),
  happened_at timestamptz not null default clock_timestamp(),
  foreign key (organisation_id,employee_id) references public.employees(organisation_id,id)
);
create table timesheet_private.pairing_requests (
  browser_digest text primary key, nonce uuid not null, code_digest text not null unique,
  expires_at timestamptz not null
);
create index pairing_expiry_idx on timesheet_private.pairing_requests(expires_at);
create table timesheet_private.pairing_limits (
  actor_id uuid primary key, window_start timestamptz not null, attempts integer not null
);
create table timesheet_private.attendance_receipts (
  device_id uuid not null references public.kiosk_devices, attempt uuid not null,
  request_id uuid not null,
  recorded_at timestamptz not null, first_name text not null, direction text not null,
  primary key(device_id,attempt)
);
create index receipt_expiry_idx on timesheet_private.attendance_receipts(recorded_at);
alter table timesheet_private.pin_audit enable row level security;
alter table timesheet_private.pairing_requests enable row level security;
alter table timesheet_private.pairing_limits enable row level security;
alter table timesheet_private.attendance_receipts enable row level security;
revoke all on timesheet_private.pin_audit,timesheet_private.pairing_requests,
  timesheet_private.pairing_limits,timesheet_private.attendance_receipts from public,anon,authenticated,service_role;

create function public.employee_profile(org uuid, employee uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  return (select jsonb_build_object('id',e.id,'name',e.display_name,'active',e.active,
    'email',u.email,'pinStatus',case when p.employee_id is null then 'none'
      when p.sealed_pin is null then 'legacy' else 'assigned' end)
    from public.employees e left join auth.users u on u.id=e.user_id
    left join timesheet_private.employee_pins p on p.employee_id=e.id
    where e.id=employee and e.organisation_id=org);
end $$;

create function public.rename_employee(org uuid, employee uuid, new_name text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if new_name is null or length(trim(new_name)) not between 1 and 120 then raise exception 'Invalid name'; end if;
  update public.employees set display_name=trim(new_name) where id=employee and organisation_id=org;
  if not found then raise exception 'Employee unavailable'; end if;
end $$;

create function public.set_employee_pin(org uuid, employee uuid, pin_verifier text, envelope text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if envelope is null then raise exception 'Missing envelope'; end if;
  perform 1 from public.employees where id=employee and organisation_id=org and active for update;
  if not found then raise exception 'Employee unavailable'; end if;
  insert into timesheet_private.employee_pins(organisation_id,employee_id,verifier,sealed_pin)
    values(org,employee,pin_verifier,envelope) on conflict(employee_id) do update
    set verifier=excluded.verifier,sealed_pin=excluded.sealed_pin,revision=gen_random_uuid();
  insert into timesheet_private.pin_audit(organisation_id,employee_id,actor_id,event)
    values(org,employee,auth.uid(),'pin_changed');
end $$;

create function public.read_employee_pin(org uuid, employee uuid) returns text
language plpgsql security definer set search_path='' as $$
declare envelope text;
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  select sealed_pin into envelope from timesheet_private.employee_pins where organisation_id=org and employee_id=employee;
  if envelope is null then raise exception 'PIN unavailable'; end if;
  insert into timesheet_private.pin_audit(organisation_id,employee_id,actor_id,event)
    values(org,employee,auth.uid(),'pin_revealed');
  return envelope;
end $$;

-- Opening a pending tablet repeatedly returns the same unconsumed challenge.
-- Only the tablet has the secret needed to derive its display code from nonce.
create function public.begin_kiosk_pairing(browser_key text, proposal uuid, code_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare pending timesheet_private.pairing_requests;
begin
  if browser_key !~ '^[a-f0-9]{64}$' or code_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid request'; end if;
  perform pg_advisory_xact_lock(hashtextextended(browser_key, 0));
  if exists(select 1 from timesheet_private.kiosk_credentials where digest=browser_key or previous_digest=browser_key)
    then return jsonb_build_object('status','registered'); end if;
  select * into pending from timesheet_private.pairing_requests where browser_digest=browser_key and expires_at>clock_timestamp();
  if not found then
    delete from timesheet_private.pairing_requests where expires_at<=clock_timestamp();
    insert into timesheet_private.pairing_requests values(browser_key,proposal,code_hash,clock_timestamp()+interval '5 minutes')
      returning * into pending;
  end if;
  return jsonb_build_object('status','pairing','nonce',pending.nonce,'expiresAt',pending.expires_at);
end $$;

create function public.pair_kiosk(org uuid, device_name text, code_hash text) returns text
language plpgsql security definer set search_path='' as $$
declare pending timesheet_private.pairing_requests; device uuid; used integer;
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if device_name is null or length(trim(device_name)) not between 1 and 80 then raise exception 'Invalid name'; end if;
  insert into timesheet_private.pairing_limits as l values(auth.uid(),clock_timestamp(),1)
    on conflict(actor_id) do update set
      attempts=case when l.window_start<=now()-interval '10 minutes' then 1 else least(l.attempts+1,11) end,
      window_start=case when l.window_start<=now()-interval '10 minutes' then now() else l.window_start end
    returning attempts into used;
  if used>10 then return 'limited'; end if;
  select * into pending from timesheet_private.pairing_requests where code_digest=code_hash;
  if not found then return 'invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(pending.browser_digest,0));
  delete from timesheet_private.pairing_requests where code_digest=code_hash and expires_at>clock_timestamp()
    returning * into pending;
  if not found then return 'invalid'; end if;
  insert into public.kiosk_devices(organisation_id,name,activated_at,expires_at)
    values(org,trim(device_name),now(),now()+interval '90 days') returning id into device;
  insert into timesheet_private.kiosk_credentials(device_id,digest) values(device,pending.browser_digest);
  return 'paired';
end $$;

create or replace function timesheet_private.lock_device(credential_digest text)
returns public.kiosk_devices language sql volatile set search_path='' as $$
  select d.* from public.kiosk_devices d join timesheet_private.kiosk_credentials k on k.device_id=d.id
  where (k.digest=credential_digest or (k.previous_digest=credential_digest and k.previous_until>clock_timestamp()))
    and d.revoked_at is null and d.expires_at>clock_timestamp() for update of d
$$;

create or replace function public.kiosk_context(credential_digest text)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('org',o.id,'name',d.name,'zone',o.timezone,'challenge',k.challenge,'locked',k.locked_until>now())
  from timesheet_private.kiosk_credentials k join public.kiosk_devices d on d.id=k.device_id
  join public.organisations o on o.id=d.organisation_id
  where (k.digest=credential_digest or (k.previous_digest=credential_digest and k.previous_until>now()))
    and d.revoked_at is null and d.expires_at>now()
$$;

-- Retry-safe rotation. During the brief overlap an interrupted response can
-- deliver the same successor cookie again without changing the registration.
create function public.kiosk_heartbeat(credential_digest text, successor text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare device public.kiosk_devices; cred timesheet_private.kiosk_credentials; renewed boolean := false;
begin
  device:=timesheet_private.lock_device(credential_digest);
  if device.id is null then
    if exists(select 1 from timesheet_private.kiosk_credentials where digest=credential_digest or previous_digest=credential_digest)
      then return jsonb_build_object('status','retired'); end if;
    return jsonb_build_object('status','unknown');
  end if;
  select * into strict cred from timesheet_private.kiosk_credentials where device_id=device.id;
  if cred.digest<>credential_digest then
    if successor<>cred.digest then return jsonb_build_object('status','retired'); end if;
    renewed:=true;
  elsif device.expires_at<now()+interval '30 days' then
    if successor is null or successor !~ '^[a-f0-9]{64}$' then raise exception 'Invalid renewal'; end if;
    update timesheet_private.kiosk_credentials set previous_digest=digest, previous_until=least(device.expires_at,now()+interval '1 day'),
      digest=successor where device_id=device.id;
    update public.kiosk_devices set expires_at=now()+interval '90 days' where id=device.id;
    renewed:=true;
  end if;
  update public.kiosk_devices set last_seen_at=now() where id=device.id
    and (last_seen_at is null or last_seen_at<now()-interval '1 minute');
  return public.kiosk_context(case when renewed then successor else credential_digest end)
    || jsonb_build_object('status','active','renewed',renewed);
end $$;

create function public.kiosk_receipt(credential_digest text, attempt_id uuid, submission uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('status','recorded','firstName',r.first_name,'action',r.direction,'at',r.recorded_at)
  from timesheet_private.attendance_receipts r
  join timesheet_private.kiosk_credentials k using(device_id)
  join public.kiosk_devices d on d.id=k.device_id
  where (k.digest=credential_digest or (k.previous_digest=credential_digest and k.previous_until>now()))
    and d.revoked_at is null and d.expires_at>now() and r.attempt=attempt_id and r.request_id=submission
    and r.recorded_at>now()-interval '24 hours'
$$;

create function public.clock_with_pin(credential_digest text, attempt_id uuid, pin_verifier text, submission uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  d public.kiosk_devices; k timesheet_private.kiosk_credentials; e public.employees; latest public.work_sessions;
  n integer; next_challenge uuid:=gen_random_uuid(); stamp timestamptz; direction text; first_name text; receipt jsonb;
begin
  d:=timesheet_private.lock_device(credential_digest);
  if d.id is null then return jsonb_build_object('status','unauthorised'); end if;
  select * into strict k from timesheet_private.kiosk_credentials where device_id=d.id;
  if submission is null then return jsonb_build_object('status','stale'); end if;
  if k.challenge is distinct from attempt_id then
    -- Two open tabs may share a challenge. Only the original submission can
    -- retrieve its receipt; a new submission on a stale screen must start over.
    receipt:=public.kiosk_receipt(credential_digest,attempt_id,submission);
    return coalesce(receipt,jsonb_build_object('status','stale'));
  end if;
  stamp:=clock_timestamp();
  if k.locked_until>stamp then return jsonb_build_object('status','locked'); end if;
  update timesheet_private.kiosk_credentials set challenge=next_challenge where device_id=d.id;
  select emp.* into e from public.employees emp join timesheet_private.employee_pins p on p.employee_id=emp.id
    where emp.organisation_id=d.organisation_id and emp.active and p.verifier=pin_verifier for update of emp;
  if e.id is null or not exists(select 1 from timesheet_private.employee_pins where employee_id=e.id and verifier=pin_verifier) then
    n:=case when k.window_start<=stamp-interval '10 minutes' then 1 else k.failures+1 end;
    update timesheet_private.kiosk_credentials set failures=n, window_start=case when n=1 then stamp else k.window_start end,
      locked_until=case when n>=5 then stamp+interval '10 minutes' end where device_id=d.id;
    return jsonb_build_object('status',case when n>=5 then 'locked' else 'invalid' end,'challenge',next_challenge);
  end if;
  select * into latest from public.work_sessions where employee_id=e.id order by started_at desc limit 1;
  stamp:=clock_timestamp();
  if stamp>=d.expires_at then return jsonb_build_object('status','unauthorised'); end if;
  -- A second kiosk may present a different valid challenge at the same instant.
  -- Compare to statement start (before lock waits) plus a short double-tap guard.
  if coalesce(latest.ended_at,latest.started_at)>=statement_timestamp()-interval '3 seconds' then
    return jsonb_build_object('status','recent','challenge',next_challenge);
  end if;
  if latest.id is not null and latest.ended_at is null then
    direction:='out';
    update public.work_sessions set ended_at=stamp,clock_out_device_id=d.id where id=latest.id;
  else
    direction:='in';
    insert into public.work_sessions(organisation_id,employee_id,started_at,clock_in_device_id)
      values(d.organisation_id,e.id,stamp,d.id);
  end if;
  first_name:=split_part(trim(e.display_name),' ',1);
  delete from timesheet_private.attendance_receipts where recorded_at<now()-interval '24 hours';
  insert into timesheet_private.attendance_receipts(device_id,attempt,request_id,recorded_at,first_name,direction)
    values(d.id,attempt_id,submission,stamp,first_name,direction);
  return jsonb_build_object('status','recorded','firstName',first_name,'at',stamp,'action',direction);
end $$;

revoke all on function public.employee_profile(uuid,uuid),public.rename_employee(uuid,uuid,text),
  public.set_employee_pin(uuid,uuid,text,text),public.read_employee_pin(uuid,uuid),
  public.begin_kiosk_pairing(text,uuid,text),public.pair_kiosk(uuid,text,text),public.kiosk_heartbeat(text,text),
  public.clock_with_pin(text,uuid,text,uuid),public.kiosk_receipt(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.employee_profile(uuid,uuid),public.rename_employee(uuid,uuid,text),
  public.set_employee_pin(uuid,uuid,text,text),public.read_employee_pin(uuid,uuid),
  public.pair_kiosk(uuid,text,text) to authenticated;
grant execute on function public.begin_kiosk_pairing(text,uuid,text),public.kiosk_heartbeat(text,text),
  public.clock_with_pin(text,uuid,text,uuid),public.kiosk_receipt(text,uuid,uuid) to service_role;
commit;
