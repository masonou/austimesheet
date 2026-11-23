begin;

create or replace function public.manage_work_session(
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
    update public.work_sessions set voided_at=stamp where id=session_id returning * into saved;
  end if;

  insert into public.timesheet_edit_history(organisation_id,session_id,changed_by,changed_at,event,reason,
    old_started_at,old_ended_at,new_started_at,new_ended_at,before_state,after_state)
    values(org,saved.id,actor,clock_timestamp(),operation,coalesce(reason,case operation
      when 'create' then 'Manually created' when 'review' then 'Marked reviewed' when 'reopen' then 'Reopened for correction' when 'void' then 'Session voided' else 'Session edited' end),
      prior.started_at,prior.ended_at,saved.started_at,saved.ended_at,
      case when prior.id is not null then to_jsonb(prior) end,to_jsonb(saved));
  return saved.revision;
end $$;

commit;
