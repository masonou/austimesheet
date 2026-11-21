begin;

alter table public.employees add column contact_email text
  check (contact_email = lower(trim(contact_email)) and length(contact_email)<=254
    and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
create unique index employee_workplace_email on public.employees(organisation_id, contact_email)
  where contact_email is not null;

create table timesheet_private.employee_invites (
  employee_id uuid primary key,
  organisation_id uuid not null,
  ticket uuid not null unique default gen_random_uuid(),
  recipient text not null,
  invited_by uuid not null,
  expires_at timestamptz not null,
  delivery text not null check (delivery in ('sending','sent','failed')),
  recipient_user uuid references auth.users on delete set null,
  foreign key (organisation_id,employee_id) references public.employees(organisation_id,id),
  foreign key (organisation_id,invited_by) references public.organisation_memberships
);
alter table timesheet_private.employee_invites enable row level security;
revoke all on timesheet_private.employee_invites from public,anon,authenticated,service_role;

create function public.create_employee(org uuid, employee uuid, full_name text, address text, pin_verifier text, envelope text)
returns boolean language plpgsql security definer set search_path='' as $$
declare mail text:=nullif(lower(trim(address)),'');
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if full_name is null or length(trim(full_name)) not between 1 and 120 or employee is null then raise exception 'Invalid employee'; end if;
  -- A stable form ID makes a lost response safe to retry, including generated PINs.
  perform pg_advisory_xact_lock(hashtextextended(employee::text,3));
  if exists(select from public.employees where id=employee and organisation_id=org and display_name=trim(full_name)
    and contact_email is not distinct from mail) then return false; end if;
  if exists(select from public.employees e join auth.users u on u.id=e.user_id
    where e.organisation_id=org and lower(u.email)=mail) then raise exception 'Email already in directory'; end if;
  if pin_verifier is null or pin_verifier !~ '^[a-f0-9]{64}$' or envelope is null then raise exception 'Invalid PIN'; end if;
  insert into public.employees(id,organisation_id,display_name,contact_email) values(employee,org,trim(full_name),mail);
  perform public.set_employee_pin(org,employee,pin_verifier,envelope);
  return true;
end $$;

create function public.set_employee_active(org uuid, employee uuid, enabled boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  update public.employees set active=enabled where id=employee and organisation_id=org;
  if not found then raise exception 'Employee unavailable'; end if;
  if not enabled then delete from timesheet_private.employee_invites where employee_id=employee; end if;
end $$;

create function public.prepare_employee_invite(org uuid, employee uuid, address text) returns uuid
language plpgsql security definer set search_path='' as $$
declare mail text:=lower(trim(address)); claim uuid:=gen_random_uuid();
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if nullif(mail,'') is null then raise exception 'Email required'; end if;
  update public.employees set contact_email=mail where id=employee and organisation_id=org and active and user_id is null;
  if not found then raise exception 'Employee unavailable'; end if;
  if exists(select from public.employees e join auth.users u on u.id=e.user_id
    where e.organisation_id=org and lower(u.email)=mail) then raise exception 'Email already in directory'; end if;
  insert into timesheet_private.employee_invites(employee_id,organisation_id,ticket,recipient,invited_by,expires_at,delivery)
    values(employee,org,claim,mail,auth.uid(),now()+interval '24 hours','sending')
    on conflict(employee_id) do update set ticket=excluded.ticket,recipient=excluded.recipient,
      invited_by=excluded.invited_by,expires_at=excluded.expires_at,delivery='sending',recipient_user=null;
  return claim;
end $$;

-- Called only by the delivery server. Neither an administrator nor the browser
-- can assert the identity of the account that an invitation will link.
create function public.finish_employee_invite(claim uuid, delivered boolean, invited_user uuid default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
  if delivered then
    select (array_agg(u.id))[1] into target from timesheet_private.employee_invites i
      join auth.users u on lower(u.email)=i.recipient where i.ticket=claim
      and (u.id=invited_user or (invited_user is null and u.email_confirmed_at is not null)) having count(*)=1;
  end if;
  update timesheet_private.employee_invites set recipient_user=target,
    delivery=case when target is null then 'failed' else 'sent' end where ticket=claim and delivery='sending';
  return found and target is not null;
end $$;

create function public.employee_invite_details(claim uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('organisation',o.name,'email',u.email,'needsPassword',
    coalesce(u.encrypted_password,'')='')
  from timesheet_private.employee_invites i join public.employees e on e.id=i.employee_id
  join public.organisations o on o.id=i.organisation_id
  join public.organisation_memberships m on m.organisation_id=o.id and m.user_id=i.invited_by and m.role='admin' and m.active
  join auth.users u on u.id=i.recipient_user and u.id=auth.uid()
  where i.ticket=claim and i.delivery='sent' and i.expires_at>now() and e.active and e.user_id is null
    and lower(u.email)=i.recipient and e.contact_email=i.recipient and u.email_confirmed_at is not null
$$;

create function public.accept_employee_invite(claim uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.employees; details jsonb;
begin
  select emp.* into e from public.employees emp join timesheet_private.employee_invites i
    on i.employee_id=emp.id where i.ticket=claim for update of emp;
  details:=public.employee_invite_details(claim);
  if e.id is null or details is null or (details->>'needsPassword')::boolean then raise insufficient_privilege; end if;
  insert into public.organisation_memberships(organisation_id,user_id,role) values(e.organisation_id,auth.uid(),'employee')
    on conflict(organisation_id,user_id) do nothing;
  perform 1 from public.organisation_memberships where organisation_id=e.organisation_id
    and user_id=auth.uid() and role='employee' and active for update;
  if not found then raise insufficient_privilege; end if;
  update public.employees set user_id=auth.uid() where id=e.id;
  delete from timesheet_private.employee_invites where ticket=claim;
  return e.organisation_id;
end $$;

create or replace function public.employee_profile(org uuid, employee uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  return (select jsonb_build_object('id',e.id,'name',e.display_name,'active',e.active,'email',coalesce(u.email,e.contact_email),
    'accountStatus',case when e.user_id is not null then 'Linked' when i.ticket is null then 'Kiosk only'
      when i.delivery='failed' then 'Email failed' when i.expires_at<=now() then 'Invitation expired'
      when i.delivery='sending' then 'Sending invitation' else 'Invitation pending' end,
    'pinStatus',case when p.employee_id is null then 'none' when p.sealed_pin is null then 'legacy' else 'assigned' end)
    from public.employees e left join auth.users u on u.id=e.user_id
    left join timesheet_private.employee_invites i on i.employee_id=e.id
    left join timesheet_private.employee_pins p on p.employee_id=e.id where e.id=employee and e.organisation_id=org);
end $$;

revoke all on function public.create_employee(uuid,uuid,text,text,text,text),public.set_employee_active(uuid,uuid,boolean),
  public.prepare_employee_invite(uuid,uuid,text),public.finish_employee_invite(uuid,boolean,uuid),
  public.employee_invite_details(uuid),public.accept_employee_invite(uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_employee(uuid,uuid,text,text,text,text),public.set_employee_active(uuid,uuid,boolean),
  public.prepare_employee_invite(uuid,uuid,text),public.employee_invite_details(uuid),public.accept_employee_invite(uuid) to authenticated;
grant execute on function public.finish_employee_invite(uuid,boolean,uuid) to service_role;
commit;
