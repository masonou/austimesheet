begin;

alter table public.organisations add column slug text unique
  check (length(slug) <= 63 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
         and slug not in ('workspace','preview','kiosk','api'));

create function timesheet_private.assign_restaurant_slug() returns trigger
language plpgsql set search_path = '' as $$
declare
  base text;
  candidate text;
  suffix text;
  counter integer := 1;
begin
  if tg_op = 'UPDATE' and old.slug is not null then
    if new.slug is distinct from old.slug then raise exception 'Restaurant slug is permanent'; end if;
    return new;
  end if;
  base := trim(both '-' from left(regexp_replace(lower(
    regexp_replace(normalize(new.name, NFKD), '[̀-ͯ]', '', 'g')
  ) collate "C", '[^a-z0-9]+', '-', 'g'),63));
  if base = '' then base := 'restaurant'; end if;
  candidate := base;
  loop
    perform pg_advisory_xact_lock(hashtextextended(candidate, 1));
    exit when candidate not in ('workspace','preview','kiosk','api')
      and not exists(select from public.organisations where slug=candidate);
    counter := counter+1;
    suffix := '-' || counter;
    candidate := rtrim(left(base,63-length(suffix)),'-') || suffix;
  end loop;
  new.slug := candidate;
  return new;
end $$;

create trigger assign_restaurant_slug before insert or update of slug on public.organisations
  for each row execute function timesheet_private.assign_restaurant_slug();
update public.organisations set slug=null where slug is null;
alter table public.organisations alter column slug set not null;

-- Read exactly the landing-page identity for a supplied slug. No public directory.
create function public.kiosk_restaurant(restaurant_slug text) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',id,'name',name) from public.organisations where slug=restaurant_slug
$$;
revoke all on function public.kiosk_restaurant(text) from public,anon,authenticated,service_role;
grant execute on function public.kiosk_restaurant(text) to service_role;
create function public.rename_kiosk(org uuid, device uuid, label text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if timesheet_private.my_role(org) is distinct from 'admin' then raise insufficient_privilege; end if;
  if label is null or length(trim(label)) not between 1 and 80 then raise exception 'Invalid device name'; end if;
  update public.kiosk_devices set name=trim(label) where id=device and organisation_id=org;
  if not found then raise exception 'Device unavailable'; end if;
end $$;
revoke all on function public.rename_kiosk(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.rename_kiosk(uuid,uuid,text) to authenticated;
commit;
