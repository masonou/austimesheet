begin;

create extension if not exists btree_gist with schema extensions;
set local search_path = public, extensions, pg_catalog;
create schema timesheet_private;
revoke all on schema timesheet_private from public, anon, authenticated;

create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  timezone text not null default 'Australia/Brisbane' check (timezone in (
    'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Broken_Hill',
    'Australia/Darwin', 'Australia/Eucla', 'Australia/Hobart', 'Australia/Lindeman',
    'Australia/Lord_Howe', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney'
  )),
  created_at timestamptz not null default now()
);

create table public.organisation_memberships (
  organisation_id uuid not null references public.organisations,
  user_id uuid not null references auth.users,
  role text not null check (role in ('admin', 'employee')),
  active boolean not null default true,
  primary key (organisation_id, user_id)
);
create index memberships_user_idx on public.organisation_memberships (user_id, organisation_id);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations,
  user_id uuid,
  display_name text not null check (btrim(display_name) <> ''),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, user_id),
  foreign key (organisation_id, user_id) references public.organisation_memberships
);

-- Device metadata only. Possession of this ID is never proof of authorisation.
create table public.kiosk_devices (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations,
  name text not null check (btrim(name) <> ''),
  activated_at timestamptz,
  revoked_at timestamptz,
  unique (organisation_id, id),
  check (revoked_at is null or (activated_at is not null and revoked_at >= activated_at))
);

create table public.work_sessions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations,
  employee_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  clock_in_device_id uuid,
  clock_out_device_id uuid,
  note text,
  reviewed_at timestamptz,
  reviewed_by uuid,
  unique (organisation_id, id),
  foreign key (organisation_id, employee_id) references public.employees (organisation_id, id),
  foreign key (organisation_id, clock_in_device_id) references public.kiosk_devices (organisation_id, id),
  foreign key (organisation_id, clock_out_device_id) references public.kiosk_devices (organisation_id, id),
  foreign key (organisation_id, reviewed_by) references public.organisation_memberships,
  check ((reviewed_at is null) = (reviewed_by is null)),
  check (ended_at is null or ended_at > started_at),
  -- An open interval extends to infinity. Adjacent sessions can share a boundary.
  exclude using gist (employee_id with =, tstzrange(started_at, ended_at, '[)') with &&)
);
create index work_sessions_org_start_idx on public.work_sessions (organisation_id, started_at, id);

create table public.timesheet_edit_history (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  session_id uuid not null,
  changed_by uuid not null,
  changed_at timestamptz not null default now(),
  reason text not null check (btrim(reason) <> ''),
  old_started_at timestamptz not null,
  old_ended_at timestamptz,
  new_started_at timestamptz not null,
  new_ended_at timestamptz,
  foreign key (organisation_id, session_id) references public.work_sessions (organisation_id, id),
  foreign key (organisation_id, changed_by) references public.organisation_memberships
);
create index edit_history_session_idx on public.timesheet_edit_history (organisation_id, session_id, changed_at);

-- Definer avoids recursive membership/employee policies. Caller identity comes
-- only from the verified session. No caller-supplied user or role argument.
create function timesheet_private.my_role(org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.organisation_memberships m
  where m.organisation_id = org and m.user_id = (select auth.uid()) and m.active
    and (m.role = 'admin' or exists (
      select 1 from public.employees e where e.organisation_id = org
      and e.user_id = m.user_id and e.active
    ))
$$;
revoke all on function timesheet_private.my_role(uuid) from public, anon, authenticated;
grant usage on schema timesheet_private to authenticated;
grant execute on function timesheet_private.my_role(uuid) to authenticated;

alter table public.organisations enable row level security;
alter table public.organisation_memberships enable row level security;
alter table public.employees enable row level security;
alter table public.kiosk_devices enable row level security;
alter table public.work_sessions enable row level security;
alter table public.timesheet_edit_history enable row level security;

revoke all on public.organisations, public.organisation_memberships, public.employees,
  public.kiosk_devices, public.work_sessions, public.timesheet_edit_history from public, anon, authenticated;
grant select on public.organisations, public.organisation_memberships, public.employees,
  public.kiosk_devices, public.work_sessions, public.timesheet_edit_history to authenticated;

create policy organisation_read on public.organisations for select to authenticated
  using (timesheet_private.my_role(id) is not null);
create policy membership_read on public.organisation_memberships for select to authenticated
  using (timesheet_private.my_role(organisation_id) = 'admin' or
    (user_id = (select auth.uid()) and timesheet_private.my_role(organisation_id) = 'employee'));
create policy employee_read on public.employees for select to authenticated
  using (timesheet_private.my_role(organisation_id) = 'admin' or
    (user_id = (select auth.uid()) and timesheet_private.my_role(organisation_id) = 'employee'));
create policy device_admin_read on public.kiosk_devices for select to authenticated
  using (timesheet_private.my_role(organisation_id) = 'admin');
create policy session_read on public.work_sessions for select to authenticated
  using (timesheet_private.my_role(organisation_id) = 'admin' or exists (
    select 1 from public.employees e where e.id = employee_id
      and e.organisation_id = work_sessions.organisation_id and e.user_id = (select auth.uid())
  ));
create policy audit_admin_read on public.timesheet_edit_history for select to authenticated
  using (timesheet_private.my_role(organisation_id) = 'admin');

commit;
