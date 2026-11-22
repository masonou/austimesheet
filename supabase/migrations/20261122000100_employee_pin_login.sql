-- Dashboard password provisioning. The filename retains the unapplied migration's version.
begin;

-- Retire the four invitation APIs while retaining their definitions and history.
revoke execute on function public.prepare_employee_invite(uuid,uuid,text),
  public.finish_employee_invite(uuid,boolean,uuid), public.employee_invite_details(uuid),
  public.accept_employee_invite(uuid) from public, anon, authenticated, service_role;

-- One operation per employee. Contains no password, password hash, or kiosk PIN.
create table timesheet_private.dashboard_login_changes (
  employee_id uuid primary key references public.employees,
  nonce uuid not null unique default gen_random_uuid(),
  actor uuid not null,
  target_user uuid not null,
  operation text not null check (operation in ('enable','reset','email')),
  address text not null,
  expires_at timestamptz not null default now()+interval '2 minutes',
  completed boolean not null default false
);
alter table timesheet_private.dashboard_login_changes enable row level security;
revoke all on table timesheet_private.dashboard_login_changes from public, anon, authenticated, service_role;

-- Existing accounts can be managed only through an existing, exclusive employee
-- membership. Matching an email address never authorises a reset or link.
create function timesheet_private.exclusive_employee_login(org uuid, target uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select from auth.users u join public.organisation_memberships m on m.user_id=u.id
    where u.id=target and u.role='authenticated' and u.is_super_admin is not true
      and u.email_confirmed_at is not null and m.organisation_id=org and m.active and m.role='employee')
    and not exists(select from public.organisation_memberships where user_id=target and organisation_id<>org)
    and not exists(select from auth.identities where user_id=target and provider<>'email')
$$;

create function public.prepare_dashboard_login(org uuid, employee uuid, actor uuid, operation text, address text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare staff public.employees; target uuid; ticket uuid;
begin
  if not exists(select from public.organisation_memberships where organisation_id=org and user_id=actor and active and role='admin')
    then raise insufficient_privilege; end if;
  select * into strict staff from public.employees where id=employee and organisation_id=org and active for update;
  if operation='enable' and staff.user_id is null then
    target:=gen_random_uuid();
  elsif operation in ('reset','email') and timesheet_private.exclusive_employee_login(org,staff.user_id) then
    target:=staff.user_id;
  else raise exception 'Login unavailable'; end if;
  if operation='reset' then select u.email into address from auth.users u where u.id=target; end if;
  address:=lower(trim(address));
  if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    then raise exception 'Invalid email'; end if;
  if exists(select from auth.users where lower(email)=address and id<>target)
    or exists(select from public.employees where organisation_id=org and id<>employee and contact_email=address)
    then raise exception 'Login email unavailable'; end if;
  insert into timesheet_private.dashboard_login_changes(employee_id,actor,target_user,operation,address)
    values(employee,actor,target,operation,address)
    on conflict(employee_id) do update set nonce=excluded.nonce,actor=excluded.actor,target_user=excluded.target_user,
      operation=excluded.operation,address=excluded.address,expires_at=excluded.expires_at,completed=false
    returning nonce into ticket;
  return jsonb_build_object('nonce',ticket,'userId',target,'address',address);
end $$;

-- Only a server Admin Auth API call can write raw_app_meta_data. GoTrue can
-- write it separately from email/password, so validate at commit. A failed
-- check rolls back the Auth change alongside the Shiftbook link.
create function timesheet_private.finish_dashboard_login() returns trigger
language plpgsql security definer set search_path='' as $$
declare change timesheet_private.dashboard_login_changes; staff public.employees; account auth.users;
begin
  select * into strict change from timesheet_private.dashboard_login_changes
    where nonce=(new.raw_app_meta_data->>'shiftbook_dashboard_change')::uuid;
  select * into strict staff from public.employees where id=change.employee_id and active for update;
  perform 1 from timesheet_private.dashboard_login_changes where nonce=change.nonce and not completed
    and expires_at>clock_timestamp() for update;
  if not found or change.target_user<>new.id then raise insufficient_privilege; end if;
  perform 1 from public.organisation_memberships where organisation_id=staff.organisation_id
    and user_id=change.actor and role='admin' and active for share;
  if not found then raise insufficient_privilege; end if;
  select * into strict account from auth.users where id=new.id for update;
  if account.role is distinct from 'authenticated' or account.is_super_admin is true or account.email_confirmed_at is null
    or lower(account.email) is distinct from change.address then raise insufficient_privilege; end if;
  perform 1 from public.organisation_memberships where user_id=new.id for update;
  if change.operation='enable' then
    if staff.user_id is not null or found then raise insufficient_privilege; end if;
    insert into public.organisation_memberships(organisation_id,user_id,role) values(staff.organisation_id,new.id,'employee');
  elsif staff.user_id is distinct from new.id or not timesheet_private.exclusive_employee_login(staff.organisation_id,new.id)
    then raise insufficient_privilege; end if;
  if change.operation in ('enable','email') then
    update public.employees set user_id=new.id, contact_email=change.address where id=staff.id;
  end if;
  update timesheet_private.dashboard_login_changes set completed=true where nonce=change.nonce;
  return null;
end $$;

create constraint trigger shiftbook_dashboard_create after insert on auth.users
  deferrable initially deferred for each row when (new.raw_app_meta_data->>'shiftbook_dashboard_change' is not null)
  execute function timesheet_private.finish_dashboard_login();
create constraint trigger shiftbook_dashboard_update after update on auth.users
  deferrable initially deferred for each row when (new.raw_app_meta_data->>'shiftbook_dashboard_change' is not null
    and (old.raw_app_meta_data->>'shiftbook_dashboard_change') is distinct from (new.raw_app_meta_data->>'shiftbook_dashboard_change'))
  execute function timesheet_private.finish_dashboard_login();

create or replace function public.employee_profile(org uuid, employee uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  return (select jsonb_build_object('id',e.id,'name',e.display_name,'active',e.active,'email',u.email,
    'accountStatus',case when e.user_id is null then 'Kiosk only' else 'Linked' end,
    'canManageLogin',e.user_id is null or timesheet_private.exclusive_employee_login(org,e.user_id),
    'pinStatus',case when p.employee_id is null then 'none' when p.sealed_pin is null then 'legacy' else 'assigned' end)
    from public.employees e left join auth.users u on u.id=e.user_id
    left join timesheet_private.employee_pins p on p.employee_id=e.id where e.organisation_id=org and e.id=employee);
end $$;
revoke all on function timesheet_private.finish_dashboard_login(), timesheet_private.exclusive_employee_login(uuid,uuid),
  public.prepare_dashboard_login(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_dashboard_login(uuid,uuid,uuid,text,text) to service_role;
commit;
