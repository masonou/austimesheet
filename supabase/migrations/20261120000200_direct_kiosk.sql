begin;
-- Supersede code pairing without deleting historical registrations or sessions.
revoke execute on function public.begin_kiosk_pairing(text,uuid,text) from service_role;
revoke execute on function public.pair_kiosk(uuid,text,text) from authenticated;

create function public.register_workplace_kiosk(org uuid, label text, new_digest text, old_digest text)
returns void language plpgsql security definer set search_path='' as $$
declare existing public.kiosk_devices; device uuid;
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if new_digest is null or new_digest !~ '^[0-9a-f]{64}$' or label is null or length(trim(label)) not between 1 and 80
    then raise exception 'Invalid kiosk'; end if;
  -- The same activation form produces the same digest, including after a lost response.
  perform pg_advisory_xact_lock(hashtextextended(new_digest,0));
  select d.* into existing from public.kiosk_devices d join timesheet_private.kiosk_credentials k on k.device_id=d.id
    where k.digest=new_digest for update of d;
  if found then
    if existing.organisation_id=org and existing.revoked_at is null and existing.expires_at>clock_timestamp() then return; end if;
    raise exception 'Start a new activation';
  end if;
  select d.* into existing from public.kiosk_devices d join timesheet_private.kiosk_credentials k on k.device_id=d.id
    where k.digest=old_digest or (k.previous_digest=old_digest and k.previous_until>now()) for update of d;
  if found and existing.organisation_id=org then
    update public.kiosk_devices set name=trim(label),activated_at=now(),expires_at=now()+interval '90 days',
      revoked_at=null,last_seen_at=now() where id=existing.id;
    update timesheet_private.kiosk_credentials set digest=new_digest,previous_digest=null,previous_until=null,
      challenge=gen_random_uuid() where device_id=existing.id;
  else
    if existing.id is not null and existing.revoked_at is null and existing.expires_at>now() then raise insufficient_privilege; end if;
    insert into public.kiosk_devices(organisation_id,name,activated_at,expires_at,last_seen_at)
      values(org,trim(label),now(),now()+interval '90 days',now()) returning id into device;
    insert into timesheet_private.kiosk_credentials(device_id,digest) values(device,new_digest);
  end if;
end $$;

create function public.exit_workplace_kiosk(browser_digest text) returns void
language plpgsql security definer set search_path='' as $$
declare device public.kiosk_devices;
begin
  device:=timesheet_private.lock_device(browser_digest);
  if device.id is null or timesheet_private.my_role(device.organisation_id) is distinct from 'admin'
    then raise insufficient_privilege; end if;
  update public.kiosk_devices set revoked_at=clock_timestamp() where id=device.id;
end $$;
revoke all on function public.register_workplace_kiosk(uuid,text,text,text),public.exit_workplace_kiosk(text)
  from public,anon,authenticated,service_role;
grant execute on function public.register_workplace_kiosk(uuid,text,text,text),public.exit_workplace_kiosk(text) to authenticated;
commit;
