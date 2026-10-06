-- Keep stored membership in sync with the canonical room after leave and kick.
create or replace function public.cr_commit(p_room jsonb, p_expected bigint)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid := (p_room->>'id')::uuid;
  v_count int;
begin
  update public.cr_rooms
  set revision = p_expected + 1, changed_at = clock_timestamp()
  where id = v_id and revision = p_expected;
  get diagnostics v_count = row_count;
  if v_count = 0 then return false; end if;

  if jsonb_array_length(p_room->'players') = 0 then
    delete from public.cr_rooms where id = v_id;
    return true;
  end if;

  update cr_private.states set data = p_room where room_id = v_id;
  delete from public.cr_members m
  where m.room_id = v_id
    and not exists (
      select 1 from jsonb_array_elements(p_room->'players') p
      where (p->>'id')::uuid = m.user_id
    );
  insert into public.cr_members(room_id, user_id)
  select v_id, (p->>'id')::uuid
  from jsonb_array_elements(p_room->'players') p
  on conflict do nothing;
  return true;
end;
$$;

revoke all on function public.cr_commit(jsonb, bigint) from public, anon, authenticated;
grant execute on function public.cr_commit(jsonb, bigint) to service_role;
