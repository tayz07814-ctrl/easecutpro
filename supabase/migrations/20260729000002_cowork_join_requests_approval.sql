-- Cloud Cowork: self-service joins now require the space owner's approval.
-- Entering a space key creates a pending request; the owner approves or declines.
-- Also: owner can regenerate the join key, and owner-initiated invites are
-- verified server-side (a leaked key alone can no longer be used to self-join).

create table if not exists public.space_join_requests (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  unique (space_id, user_id)
);
alter table public.space_join_requests enable row level security;
-- All access is via the SECURITY DEFINER RPCs below; no direct-table policies.

-- Request to join by key -> pending request + notify the owner.
create or replace function public.cowork_request_join(p_key text)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_space uuid; v_owner uuid; v_sname text; v_from text; v_existing text;
begin
  select id, owner_id, name into v_space, v_owner, v_sname
    from public.spaces where upper(join_key) = upper(trim(p_key)) limit 1;
  if v_space is null then return 'not_found'; end if;
  if v_owner = auth.uid() then return 'already_member'; end if;
  if exists (select 1 from public.space_members where space_id = v_space and user_id = auth.uid()) then
    return 'already_member';
  end if;
  select status into v_existing from public.space_join_requests
    where space_id = v_space and user_id = auth.uid();
  if v_existing = 'pending' then return 'pending'; end if;
  insert into public.space_join_requests(space_id, user_id, status)
    values (v_space, auth.uid(), 'pending')
    on conflict (space_id, user_id) do update set status = 'pending', created_at = now();
  select coalesce(nullif(display_name,''), nullif(username,''), email) into v_from
    from public.profiles where id = auth.uid();
  insert into public.notifications(user_id, kind, space_id, space_name, from_name, message)
    values (v_owner, 'join_request', v_space, v_sname, v_from,
            coalesce(v_from,'Someone') || ' asked to join "' || coalesce(v_sname,'a space') || '"');
  return 'requested';
end; $$;

-- Owner lists pending requests (with requester identity).
create or replace function public.cowork_list_requests(p_space uuid)
returns table(id uuid, user_id uuid, username text, email text, name text, created_at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select r.id, r.user_id,
         coalesce(p.username,'') as username,
         coalesce(p.email,'') as email,
         coalesce(nullif(p.display_name,''), nullif(p.username,''),
                  nullif(split_part(coalesce(p.email,''),'@',1),''), 'Member') as name,
         r.created_at
  from public.space_join_requests r
  left join public.profiles p on p.id = r.user_id
  where r.space_id = p_space and r.status = 'pending'
    and exists (select 1 from public.spaces s where s.id = p_space and s.owner_id = auth.uid())
  order by r.created_at;
$$;

-- Owner approves (adds the member) or rejects a request; notifies the requester.
create or replace function public.cowork_decide_request(p_request uuid, p_approve boolean)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_space uuid; v_user uuid; v_owner uuid; v_sname text; v_key text;
begin
  select r.space_id, r.user_id into v_space, v_user
    from public.space_join_requests r where r.id = p_request;
  if v_space is null then return 'not_found'; end if;
  select owner_id, name, join_key into v_owner, v_sname, v_key from public.spaces where id = v_space;
  if v_owner is null or v_owner <> auth.uid() then return 'forbidden'; end if;
  if p_approve then
    insert into public.space_members(space_id, user_id, role)
      values (v_space, v_user, 'editor') on conflict (space_id, user_id) do nothing;
    update public.space_join_requests set status = 'approved' where id = p_request;
    insert into public.notifications(user_id, kind, space_id, space_name, join_key, from_name, message)
      values (v_user, 'join_approved', v_space, v_sname, v_key, null,
              'You were added to "' || coalesce(v_sname,'a space') || '"');
    return 'approved';
  else
    update public.space_join_requests set status = 'rejected' where id = p_request;
    insert into public.notifications(user_id, kind, space_id, space_name, from_name, message)
      values (v_user, 'join_rejected', v_space, v_sname, null,
              'Your request to join "' || coalesce(v_sname,'a space') || '" was declined');
    return 'rejected';
  end if;
end; $$;

-- Accept an owner-initiated invite (requires a matching space_invite notification).
create or replace function public.cowork_accept_invite(p_space uuid)
returns text language plpgsql security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from public.notifications
                 where user_id = auth.uid() and space_id = p_space and kind = 'space_invite') then
    return 'no_invite';
  end if;
  insert into public.space_members(space_id, user_id, role)
    values (p_space, auth.uid(), 'editor') on conflict (space_id, user_id) do nothing;
  update public.notifications set read = true
    where user_id = auth.uid() and space_id = p_space and kind = 'space_invite';
  return p_space::text;
end; $$;

-- Owner mints a fresh random join key (invalidates the old one).
create or replace function public.cowork_regen_key(p_space uuid)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_key text;
begin
  if not exists (select 1 from public.spaces where id = p_space and owner_id = auth.uid()) then
    return 'forbidden';
  end if;
  v_key := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  update public.spaces set join_key = v_key where id = p_space;
  return v_key;
end; $$;

-- Neuter the legacy direct-join path so a leaked key can't bypass approval.
create or replace function public.cowork_join_by_key(p_key text)
returns text language plpgsql security definer set search_path to 'public' as $$
begin
  return public.cowork_request_join(p_key);
end; $$;

grant execute on function public.cowork_request_join(text) to authenticated;
grant execute on function public.cowork_list_requests(uuid) to authenticated;
grant execute on function public.cowork_decide_request(uuid, boolean) to authenticated;
grant execute on function public.cowork_accept_invite(uuid) to authenticated;
grant execute on function public.cowork_regen_key(uuid) to authenticated;
