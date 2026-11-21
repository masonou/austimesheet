begin;
set local search_path = public, extensions, pg_catalog;

alter table public.work_sessions
  add column revision bigint not null default 1,
  add column created_by uuid,
  add column voided_at timestamptz,
  add foreign key (organisation_id, created_by) references public.organisation_memberships,
  add constraint completed_session_review check (reviewed_at is null or ended_at is not null) not valid;

-- Voiding retains both the row and its device references. Its time becomes available again.
alter table public.work_sessions drop constraint work_sessions_employee_id_tstzrange_excl,
  add constraint work_sessions_no_overlap exclude using gist
  (employee_id with =, tstzrange(started_at, ended_at, '[)') with &&) where (voided_at is null);

alter table public.timesheet_edit_history
  alter column old_started_at drop not null,
  add column event text not null default 'edit' check (event in ('create','edit','review','reopen','void')),
  add column before_state jsonb,
  add column after_state jsonb;

create function timesheet_private.bump_session_revision() returns trigger
language plpgsql set search_path='' as $$
begin
  new.revision := old.revision + 1;
  return new;
end $$;
create trigger bump_session_revision before update on public.work_sessions
for each row execute function timesheet_private.bump_session_revision();

-- The employee lock uses the same order as a kiosk clock. The exclusion constraint
-- also protects the interval when administrators submit two competing inserts.
create function public.manage_work_session(
  org uuid, employee uuid, session_id uuid, operation text, expected_revision bigint,
  start_time timestamptz, finish_time timestamptz, session_note text, change_reason text
) returns bigint language plpgsql security definer set search_path='' as $$
declare
  prior public.work_sessions;
  saved public.work_sessions;
  actor uuid := auth.uid();
  reason text := nullif(regexp_replace(change_reason, '^\s+|\s+$', '', 'g'), '');
  stamp timestamptz := clock_timestamp();
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if operation is null or operation not in ('create','edit','review','reopen','void') or session_id is null then
    raise exception 'Invalid operation';
  end if;
  perform 1 from public.employees where id=employee and organisation_id=org for update;
  if not found then raise exception 'Session unavailable'; end if;

  if operation <> 'create' then
    select * into prior from public.work_sessions s
      where s.id=session_id and s.organisation_id=org and s.employee_id=employee for update;
    if not found then raise exception 'Session unavailable'; end if;
    if prior.revision is distinct from expected_revision then raise exception 'Session changed'; end if;
    if prior.voided_at is not null then raise exception 'Session already voided'; end if;
    if prior.reviewed_at is not null and operation <> 'reopen' then raise exception 'Reopen this session first'; end if;
  end if;

  if operation in ('create','edit') then
    if start_time is null or not isfinite(start_time) or start_time > stamp
      or (finish_time is not null and (not isfinite(finish_time) or finish_time <= start_time or finish_time > stamp))
      or (finish_time is null and (operation='create' or prior.ended_at is not null)) then
      raise exception 'Invalid shift times';
    end if;
    if (prior.started_at is distinct from start_time or prior.ended_at is distinct from finish_time) and reason is null
      then raise exception 'A reason is required'; end if;
    if operation='create' then
      insert into public.work_sessions(id,organisation_id,employee_id,started_at,ended_at,note,created_by)
        values(session_id,org,employee,start_time,finish_time,session_note,actor) returning * into saved;
    else
      if prior.started_at=start_time and prior.ended_at is not distinct from finish_time and prior.note is not distinct from session_note
        then raise exception 'No changes to save'; end if;
      update public.work_sessions set started_at=start_time, ended_at=finish_time, note=session_note
        where id=session_id returning * into saved;
    end if;
  elsif operation='review' then
    if prior.ended_at is null then raise exception 'Open sessions cannot be reviewed'; end if;
    update public.work_sessions set reviewed_at=stamp, reviewed_by=actor where id=session_id returning * into saved;
  elsif operation='reopen' then
    if prior.reviewed_at is null then raise exception 'Session is already pending'; end if;
    update public.work_sessions set reviewed_at=null, reviewed_by=null where id=session_id returning * into saved;
  else
    if reason is null then raise exception 'A reason is required'; end if;
    update public.work_sessions set voided_at=stamp where id=session_id returning * into saved;
  end if;

  insert into public.timesheet_edit_history(organisation_id,session_id,changed_by,changed_at,event,reason,
    old_started_at,old_ended_at,new_started_at,new_ended_at,before_state,after_state)
    values(org,saved.id,actor,clock_timestamp(),operation,coalesce(reason,case operation
      when 'review' then 'Marked reviewed' when 'reopen' then 'Reopened for correction' else 'Updated note' end),
      prior.started_at,prior.ended_at,saved.started_at,saved.ended_at,
      case when prior.id is not null then to_jsonb(prior) end,to_jsonb(saved));
  return saved.revision;
end $$;
revoke all on function public.manage_work_session(uuid,uuid,uuid,text,bigint,timestamptz,timestamptz,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.manage_work_session(uuid,uuid,uuid,text,bigint,timestamptz,timestamptz,text,text)
  to authenticated;

-- Preserve the clock transaction and receipts, using the latest non-voided shift.
create or replace function public.clock_with_pin(credential_digest text, attempt_id uuid, pin_verifier text, submission uuid) returns jsonb
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
  select * into latest from public.work_sessions where employee_id=e.id and voided_at is null order by started_at desc limit 1;
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

commit;
