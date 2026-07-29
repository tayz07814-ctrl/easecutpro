-- Folders inside a Cloud Cowork space (shared across members, cross-device).
create table if not exists public.space_folders (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  name text not null default 'New folder',
  created_at timestamptz not null default now()
);
alter table public.space_folders enable row level security;
create policy sf_select on public.space_folders for select using (public.is_space_member(space_id));
create policy sf_insert on public.space_folders for insert with check (public.is_space_member(space_id));
create policy sf_update on public.space_folders for update using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));
create policy sf_delete on public.space_folders for delete using (public.is_space_member(space_id));

-- Which folder a shared project is filed under (null = unfiled). Deleting a
-- folder unfiles its projects automatically.
alter table public.space_projects
  add column if not exists folder_id uuid references public.space_folders(id) on delete set null;

-- Move a project into (or out of) a folder — any member may organise.
create or replace function public.cowork_move_project(p_project uuid, p_folder uuid)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_space uuid; v_fspace uuid;
begin
  select space_id into v_space from public.space_projects where id = p_project;
  if v_space is null then return 'not_found'; end if;
  if not public.is_space_member(v_space) then return 'forbidden'; end if;
  if p_folder is not null then
    select space_id into v_fspace from public.space_folders where id = p_folder;
    if v_fspace is distinct from v_space then return 'bad_folder'; end if;
  end if;
  update public.space_projects set folder_id = p_folder where id = p_project;
  return 'ok';
end; $$;
grant execute on function public.cowork_move_project(uuid, uuid) to authenticated;
