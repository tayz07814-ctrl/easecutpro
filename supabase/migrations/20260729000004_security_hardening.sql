-- Security hardening pass (audit follow-up). Each block is an independent,
-- idempotent fix; none change the client's current behaviour (the app only
-- READS quota_bytes/is_paid, only WRITES profiles.username, and never sets
-- space_members.role directly), so these only close abuse paths.

-- ── 1) profiles.email is server-managed (closes invite-by-email impersonation) ──
-- RLS is row-level, so "update own profile" also let a user rewrite their OWN
-- email. profiles.email has no unique constraint and cowork_invite() resolves an
-- invite by `username OR email` — so a user could set their email to a
-- colleague's address and be the one who receives (and accepts) a space invite
-- meant for that colleague. Freeze email on client updates: it stays whatever
-- handle_new_user() copied from auth.users at signup. Service role still can.
create or replace function public.profiles_freeze_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    new.email := old.email; -- ignore any client-supplied email change
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_no_email_change on public.profiles;
create trigger profiles_no_email_change before update on public.profiles
  for each row execute function public.profiles_freeze_email();

-- ── 2) spaces.quota_bytes / is_paid are server-managed (closes quota bypass) ──
-- The "spaces: owner update" policy lets the owner update any column, and
-- r2-sign enforces the storage cap by reading spaces.quota_bytes — so an owner
-- could set their own quota to unlimited (and flip is_paid) with the anon key.
-- Pin both to their old values on any non-service-role update; a payment flow
-- running as service role can still change them.
create or replace function public.spaces_freeze_billing() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    new.quota_bytes := old.quota_bytes;
    new.is_paid := old.is_paid;
  end if;
  return new;
end;
$$;
drop trigger if exists spaces_no_billing_change on public.spaces;
create trigger spaces_no_billing_change before update on public.spaces
  for each row execute function public.spaces_freeze_billing();

-- ── 3) Enforce the viewer role (read-only) on shared writes ──────────────────
-- space_members.role has a check for ('owner','editor','viewer') but NO policy
-- ever referenced it: a "viewer" had full create/update/delete over shared
-- projects and folders. Gate writes on an editor-or-owner membership; reads stay
-- open to any member.
create or replace function public.is_space_editor(p_space uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.space_members m
     where m.space_id = p_space and m.user_id = auth.uid()
       and m.role in ('owner','editor')
  ) or exists (
    select 1 from public.spaces s where s.id = p_space and s.owner_id = auth.uid()
  );
$$;
grant execute on function public.is_space_editor(uuid) to authenticated;

-- space_projects: split the old "member all" into member-read + editor-write.
drop policy if exists "projects: member all" on public.space_projects;
drop policy if exists "projects: read as member" on public.space_projects;
create policy "projects: read as member" on public.space_projects for select to authenticated
  using (public.is_space_member(space_id));
drop policy if exists "projects: editor insert" on public.space_projects;
create policy "projects: editor insert" on public.space_projects for insert to authenticated
  with check (public.is_space_editor(space_id));
drop policy if exists "projects: editor update" on public.space_projects;
create policy "projects: editor update" on public.space_projects for update to authenticated
  using (public.is_space_editor(space_id)) with check (public.is_space_editor(space_id));
drop policy if exists "projects: editor delete" on public.space_projects;
create policy "projects: editor delete" on public.space_projects for delete to authenticated
  using (public.is_space_editor(space_id));

-- space_folders: same split (was sf_* on plain membership).
drop policy if exists sf_insert on public.space_folders;
drop policy if exists sf_update on public.space_folders;
drop policy if exists sf_delete on public.space_folders;
create policy sf_insert on public.space_folders for insert to authenticated
  with check (public.is_space_editor(space_id));
create policy sf_update on public.space_folders for update to authenticated
  using (public.is_space_editor(space_id)) with check (public.is_space_editor(space_id));
create policy sf_delete on public.space_folders for delete to authenticated
  using (public.is_space_editor(space_id));

-- ── 4) space_project_edits UPDATE must re-check project membership ────────────
-- INSERT required is_project_member, but UPDATE only checked user_id = auth.uid()
-- with no project recheck, so a member could repoint their edit row's project_id
-- at a project/space they don't belong to (edit-list spoofing). Re-assert it.
drop policy if exists "edits: own update" on public.space_project_edits;
create policy "edits: own update" on public.space_project_edits for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_project_member(project_id));

-- ── 5) Explicit WITH CHECK on the member-update policy (hardening) ────────────
-- Postgres reuses USING as WITH CHECK when omitted (so this was not exploitable),
-- but state it explicitly so a future edit can't silently widen it.
drop policy if exists "members: owner update" on public.space_members;
create policy "members: owner update" on public.space_members for update to authenticated
  using (exists (select 1 from public.spaces s where s.id = space_id and s.owner_id = auth.uid()))
  with check (exists (select 1 from public.spaces s where s.id = space_id and s.owner_id = auth.uid()));
