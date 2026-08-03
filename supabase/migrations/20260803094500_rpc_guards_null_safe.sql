-- Two auth bypasses in the same family as the ledger one, found while verifying
-- that fix: a SECURITY DEFINER function that is reachable by `anon` and whose
-- owner check compares against auth.uid() with `<>`.
--
-- For an anonymous request auth.uid() is NULL, so:
--
--     if v_owner is null or v_owner <> auth.uid() then return 'forbidden'; end if;
--         false      OR      NULL                -->  NULL
--
-- and plpgsql runs `IF NULL` as the false branch. The guard does not refuse —
-- it falls through, and the rest of the function runs with no caller at all.
--
-- Verified against production before this migration: cowork_invite called with
-- only the public anon key and a real space id returned 'no_account' (it had
-- reached the profile lookup) instead of 'forbidden'. With a REAL username it
-- would have written that user a notification carrying the space's join_key,
-- which is enough to then join the space. cowork_decide_request has the same
-- shape and would let anyone approve a pending join request, which is exactly
-- the owner approval step that flow exists to enforce.
--
-- The fix is `is distinct from` (NULL-safe) plus an explicit signed-in check,
-- and then taking EXECUTE away from anon entirely — none of these functions can
-- do anything useful without auth.uid(), so anon has no business calling them.
--
-- cowork_regen_key, cowork_accept_invite, cowork_list_requests,
-- cowork_move_project and every admin_* function were checked too: they all use
-- `not exists (...)` or `if not public.is_app_admin()`, which yield false for a
-- NULL uid and therefore refuse correctly. They are left as they are.

create or replace function public.cowork_invite(p_space uuid, p_identifier text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid; v_owner uuid; v_sname text; v_key text; v_from text; v_id text;
begin
  if auth.uid() is null then return 'forbidden'; end if;
  select owner_id, name, join_key into v_owner, v_sname, v_key from public.spaces where id = p_space;
  if v_owner is null or v_owner is distinct from auth.uid() then return 'forbidden'; end if;
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

create or replace function public.cowork_decide_request(p_request uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_space uuid; v_user uuid; v_owner uuid; v_sname text; v_key text;
begin
  if auth.uid() is null then return 'forbidden'; end if;
  select r.space_id, r.user_id into v_space, v_user
    from public.space_join_requests r where r.id = p_request;
  if v_space is null then return 'not_found'; end if;
  select owner_id, name, join_key into v_owner, v_sname, v_key from public.spaces where id = v_space;
  if v_owner is null or v_owner is distinct from auth.uid() then return 'forbidden'; end if;
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

-- Same class, smaller blast radius: with a NULL uid the `v_owner = auth.uid()`
-- test also falls through, and the function goes on to insert a join request
-- with user_id NULL and notify the owner. Anyone holding a join key could have
-- used it to spam the owner's notification bell.
create or replace function public.cowork_request_join(p_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_space uuid; v_owner uuid; v_sname text; v_from text; v_existing text;
begin
  if auth.uid() is null then return 'forbidden'; end if;
  select id, owner_id, name into v_space, v_owner, v_sname
    from public.spaces where upper(join_key) = upper(trim(p_key)) limit 1;
  if v_space is null then return 'not_found'; end if;
  if v_owner is not distinct from auth.uid() then return 'already_member'; end if;
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

-- Every cowork_* and admin_* entry point needs a signed-in caller to mean
-- anything, so anon loses EXECUTE on all of them.
--
-- BOTH revokes are required, and for opposite reasons. Supabase's default
-- privileges hand out an explicit `anon=X` grant, which `revoke ... from public`
-- does not touch (that was the ledger bug). But EXECUTE is also granted to
-- PUBLIC by default — shown as `=X/postgres` in proacl — and anon is a member of
-- PUBLIC, so revoking only from anon leaves it reachable anyway. Miss either one
-- and the function is still callable with the anon key that ships in the bundle.
--
-- `authenticated` and `service_role` are then re-granted explicitly, so dropping
-- the PUBLIC grant can't take the app's own access with it.
--
-- (The live database first got a version of this loop that revoked only from
-- anon; the PUBLIC grant kept everything reachable and a follow-up migration,
-- rpc_guards_revoke_public_too, closed it. This file is the corrected form, so a
-- fresh `db push` lands on the same end state in one step.)
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'cowork\_%' or p.proname like 'admin\_%')
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- AI metering takes the user id as an ARGUMENT and is called only by the stt
-- edge function with the service role. While anon/authenticated could execute
-- it, anyone could spend a named user's AI minutes for them:
--   consume_ai_seconds('<victim uuid>', 999999, 0)
-- Nothing client-side calls either function, so both become service-role only.
revoke all on function public.consume_ai_seconds(uuid, integer, integer) from public;
revoke all on function public.consume_ai_seconds(uuid, integer, integer) from anon;
revoke all on function public.consume_ai_seconds(uuid, integer, integer) from authenticated;
grant execute on function public.consume_ai_seconds(uuid, integer, integer) to service_role;

revoke all on function public.consume_ai_run(uuid, boolean) from public;
revoke all on function public.consume_ai_run(uuid, boolean) from anon;
revoke all on function public.consume_ai_run(uuid, boolean) from authenticated;
grant execute on function public.consume_ai_run(uuid, boolean) to service_role;
