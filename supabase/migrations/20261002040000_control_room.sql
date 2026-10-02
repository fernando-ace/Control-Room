-- The canonical simulation is never exposed to browsers, including its role secrets.
create schema if not exists cr_private;
revoke all on schema cr_private from public, anon, authenticated;
create table public.cr_rooms (
 id uuid primary key,
 code text not null unique check (code ~ '^[A-Z2-9]{6}$'),
 revision bigint not null default 0,
 changed_at timestamptz not null default now()
);
create table public.cr_members (
 room_id uuid not null references public.cr_rooms(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 primary key(room_id,user_id)
);
create table cr_private.states (
 room_id uuid primary key references public.cr_rooms(id) on delete cascade,
 data jsonb not null
);
alter table public.cr_rooms enable row level security;
alter table public.cr_members enable row level security;
alter table cr_private.states enable row level security;
revoke all on public.cr_rooms, public.cr_members from anon, authenticated;
grant select on public.cr_rooms, public.cr_members to authenticated;
create policy "own memberships" on public.cr_members for select to authenticated using(user_id = (select auth.uid()));
create policy "members see room notifications" on public.cr_rooms for select to authenticated using(exists(select 1 from public.cr_members m where m.room_id=id and m.user_id=(select auth.uid())));
grant usage on schema cr_private to service_role;
grant all on cr_private.states, public.cr_rooms, public.cr_members to service_role;
-- These RPCs are service-role-only and security invoker. Browsers cannot submit a forged snapshot.
create function public.cr_create(p_room jsonb) returns void language plpgsql security invoker set search_path='' as $$
begin
 insert into public.cr_rooms(id,code,revision) values((p_room->>'id')::uuid,p_room->>'code',0);
 insert into cr_private.states(room_id,data) values((p_room->>'id')::uuid,p_room);
 insert into public.cr_members(room_id,user_id) values((p_room->>'id')::uuid,(p_room->>'hostId')::uuid);
end;$$;
create function public.cr_read(p_code text) returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('room',s.data,'now',floor(extract(epoch from clock_timestamp())*1000))
 from cr_private.states s join public.cr_rooms r on r.id=s.room_id where r.code=p_code;
$$;
create function public.cr_commit(p_room jsonb,p_expected bigint) returns boolean language plpgsql security invoker set search_path='' as $$
declare v_id uuid := (p_room->>'id')::uuid; v_count int;
begin
 update public.cr_rooms set revision=p_expected+1,changed_at=clock_timestamp() where id=v_id and revision=p_expected;
 get diagnostics v_count = row_count;
 if v_count=0 then return false; end if;
 update cr_private.states set data=p_room where room_id=v_id;
 insert into public.cr_members(room_id,user_id)
 select v_id,(p->>'id')::uuid from jsonb_array_elements(p_room->'players') p on conflict do nothing;
 return true;
end;$$;
revoke all on function public.cr_create(jsonb),public.cr_read(text),public.cr_commit(jsonb,bigint) from public,anon,authenticated;
grant execute on function public.cr_create(jsonb),public.cr_read(text),public.cr_commit(jsonb,bigint) to service_role;
alter publication supabase_realtime add table public.cr_rooms;
