-- Cloud Cowork: shared spaces, team membership, projects, and per-member edit
-- files. Files (project edits JSON + raw media) live in Cloudflare R2; these
-- tables are the metadata + membership + quota ledger. RLS is membership-driven.

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  quota_bytes bigint not null default 107374182400,   -- 100 GiB free per space
  is_paid boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.space_members (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  unique (space_id, user_id)
);

create table if not exists public.space_projects (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  name text not null,
  media_bytes bigint not null default 0,          -- raw media in R2 (the quota driver)
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One edit file per member per project (R2: .../projects/{project}/edits/{user}.json).
create table if not exists public.space_project_edits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.space_projects(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  member_name text,                                -- display label for the version dropdown
  bytes bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (project_id, user_id)
);

-- Membership checks as SECURITY DEFINER so RLS policies don't recurse on space_members.
create or replace function public.is_space_member(p_space uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.space_members m where m.space_id = p_space and m.user_id = auth.uid())
      or exists (select 1 from public.spaces s where s.id = p_space and s.owner_id = auth.uid());
$$;

create or replace function public.is_project_member(p_project uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select public.is_space_member((select space_id from public.space_projects where id = p_project));
$$;

-- The space owner is always a member (for listings + the members panel).
create or replace function public.add_owner_membership() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.space_members(space_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (space_id, user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists spaces_add_owner on public.spaces;
create trigger spaces_add_owner after insert on public.spaces
  for each row execute function public.add_owner_membership();

alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.space_projects enable row level security;
alter table public.space_project_edits enable row level security;

drop policy if exists "spaces: read as member" on public.spaces;
create policy "spaces: read as member" on public.spaces for select to authenticated
  using (owner_id = auth.uid() or public.is_space_member(id));
drop policy if exists "spaces: owner insert" on public.spaces;
create policy "spaces: owner insert" on public.spaces for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists "spaces: owner update" on public.spaces;
create policy "spaces: owner update" on public.spaces for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "spaces: owner delete" on public.spaces;
create policy "spaces: owner delete" on public.spaces for delete to authenticated
  using (owner_id = auth.uid());

drop policy if exists "members: read as member" on public.space_members;
create policy "members: read as member" on public.space_members for select to authenticated
  using (public.is_space_member(space_id));
drop policy if exists "members: owner insert" on public.space_members;
create policy "members: owner insert" on public.space_members for insert to authenticated
  with check (exists (select 1 from public.spaces s where s.id = space_id and s.owner_id = auth.uid()));
drop policy if exists "members: owner update" on public.space_members;
create policy "members: owner update" on public.space_members for update to authenticated
  using (exists (select 1 from public.spaces s where s.id = space_id and s.owner_id = auth.uid()));
drop policy if exists "members: owner or self delete" on public.space_members;
create policy "members: owner or self delete" on public.space_members for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.spaces s where s.id = space_id and s.owner_id = auth.uid()));

drop policy if exists "projects: member all" on public.space_projects;
create policy "projects: member all" on public.space_projects for all to authenticated
  using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

drop policy if exists "edits: read as member" on public.space_project_edits;
create policy "edits: read as member" on public.space_project_edits for select to authenticated
  using (public.is_project_member(project_id));
drop policy if exists "edits: own insert" on public.space_project_edits;
create policy "edits: own insert" on public.space_project_edits for insert to authenticated
  with check (user_id = auth.uid() and public.is_project_member(project_id));
drop policy if exists "edits: own update" on public.space_project_edits;
create policy "edits: own update" on public.space_project_edits for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "edits: own delete" on public.space_project_edits;
create policy "edits: own delete" on public.space_project_edits for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on
  public.spaces, public.space_members, public.space_projects, public.space_project_edits
  to authenticated;
grant execute on function public.is_space_member(uuid), public.is_project_member(uuid) to authenticated;
