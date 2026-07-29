-- Cloud Cowork, round 2: mandatory usernames, space join keys, in-app
-- notifications, and the RPCs that let members find each other without opening
-- up the locked-down `profiles` table (which is read-own-only). Invites are now
-- notifications the recipient accepts, and anyone can join a space with its key.

-- ── 1) Usernames on profiles ────────────────────────────────────────────────
alter table public.profiles add column if not exists username text;

-- Backfill every existing account with a random handle so usernames are usable
-- immediately (users can change theirs later; uniqueness is enforced below).
update public.profiles
set username = 'user_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)
where username is null or username = '';

create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));

-- New signups: handle_new_user() inserts (id, email) only, so give every fresh
-- profile row a username here if one wasn't supplied.
create or replace function public.profiles_default_username() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.username is null or new.username = '' then
    new.username := 'user_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_set_username on public.profiles;
create trigger profiles_set_username before insert on public.profiles
  for each row execute function public.profiles_default_username();

-- ── 2) Space join keys ──────────────────────────────────────────────────────
-- A short shareable code; entering it joins the space. Only members can read a
-- space row (RLS), so the key is only visible to people already in the space.
alter table public.spaces add column if not exists join_key text;
update public.spaces
set join_key = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
where join_key is null or join_key = '';
alter table public.spaces
  alter column join_key set default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
create unique index if not exists spaces_join_key_key on public.spaces (join_key);

-- ── 3) In-app notifications ─────────────────────────────────────────────────
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,   -- recipient
  kind text not null default 'space_invite',
  space_id uuid references public.spaces(id) on delete cascade,
  space_name text,
  join_key text,
  from_name text,
  message text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
-- Recipients read / update (mark read) / delete their own. Rows are only ever
-- created by the SECURITY DEFINER RPCs below (no direct insert policy), so no one
-- can spam another user's inbox by writing rows directly.
drop policy if exists "notif: read own" on public.notifications;
create policy "notif: read own" on public.notifications for select to authenticated using (user_id = auth.uid());
drop policy if exists "notif: update own" on public.notifications;
create policy "notif: update own" on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "notif: delete own" on public.notifications;
create policy "notif: delete own" on public.notifications for delete to authenticated using (user_id = auth.uid());
grant select, update, delete on public.notifications to authenticated;

-- ── 4) RPCs (SECURITY DEFINER — bounded reads/writes over locked tables) ─────

-- Enriched member list (username/email/display name) for a space the caller is
-- a member of. Bypasses the read-own profiles RLS but only for co-members.
create or replace function public.cowork_members(p_space uuid)
returns table (user_id uuid, role text, username text, email text, name text)
language sql security definer stable set search_path = public as $$
  select m.user_id, m.role,
         coalesce(p.username, '') as username,
         coalesce(p.email, '') as email,
         coalesce(nullif(p.display_name, ''), nullif(p.username, ''),
                  nullif(split_part(coalesce(p.email, ''), '@', 1), ''), 'Member') as name
  from public.space_members m
  left join public.profiles p on p.id = m.user_id
  where m.space_id = p_space and public.is_space_member(p_space);
$$;

-- Invite by username OR email → drops a notification in the target's inbox (does
-- NOT add them; they accept). Owner-only. Returns a status code.
create or replace function public.cowork_invite(p_space uuid, p_identifier text)
returns text language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_owner uuid; v_sname text; v_key text; v_from text; v_id text;
begin
  select owner_id, name, join_key into v_owner, v_sname, v_key from public.spaces where id = p_space;
  if v_owner is null or v_owner <> auth.uid() then return 'forbidden'; end if;
  v_id := trim(p_identifier);
  if v_id = '' then return 'no_account'; end if;
  select id into v_uid from public.profiles
    where lower(username) = lower(v_id) or lower(email) = lower(v_id) limit 1;
  if v_uid is null then return 'no_account'; end if;
  if exists (select 1 from public.space_members where space_id = p_space and user_id = v_uid) then
    return 'already_member';
  end if;
  select coalesce(nullif(display_name, ''), nullif(username, ''), email) into v_from
    from public.profiles where id = auth.uid();
  insert into public.notifications(user_id, kind, space_id, space_name, join_key, from_name, message)
  values (v_uid, 'space_invite', p_space, v_sname, v_key, v_from,
          coalesce(v_from, 'Someone') || ' invited you to "' || coalesce(v_sname, 'a space') || '"');
  return 'ok';
end;
$$;

-- Join a space by its key (from an invite or shared directly). Returns the space
-- id on success, or 'not_found'. Also clears any pending invite for that space.
create or replace function public.cowork_join_by_key(p_key text)
returns text language plpgsql security definer set search_path = public as $$
declare v_space uuid;
begin
  select id into v_space from public.spaces where upper(join_key) = upper(trim(p_key)) limit 1;
  if v_space is null then return 'not_found'; end if;
  insert into public.space_members(space_id, user_id, role)
  values (v_space, auth.uid(), 'editor')
  on conflict (space_id, user_id) do nothing;
  update public.notifications set read = true
    where user_id = auth.uid() and space_id = v_space and kind = 'space_invite';
  return v_space::text;
end;
$$;

grant execute on function
  public.cowork_members(uuid), public.cowork_invite(uuid, text), public.cowork_join_by_key(text)
  to authenticated;
