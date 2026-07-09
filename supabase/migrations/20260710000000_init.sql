-- EaseCutPro cloud backend — initial schema.
-- Media NEVER lives here: source video stays on the user's device (browser
-- IndexedDB). Supabase stores only accounts/profiles, project JSON (which
-- embeds the transcript), per-user settings, and a private TEMP bucket for
-- the small extracted audio the STT edge function transcribes and deletes.

-- ---- profiles (auto-created on signup) ----
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- shared updated_at touch ----
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---- projects (the full ProjectRec: edit doc + embedded transcript + thumb) ----
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'Untitled',
  project jsonb,
  thumb text, -- data-URL, client caps it at 400 KB (same cap the PC server enforced)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_user_updated
  on public.projects (user_id, updated_at desc);
alter table public.projects enable row level security;
create policy "projects: own rows" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop trigger if exists projects_touch on public.projects;
create trigger projects_touch
  before update on public.projects
  for each row execute function public.touch_updated_at();

-- ---- per-user app settings (replaces the ec.* localStorage keys as source of truth) ----
create table if not exists public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
create policy "settings: own row" on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop trigger if exists settings_touch on public.user_settings;
create trigger settings_touch
  before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- ---- temp bucket for extracted STT audio (private; edge function signs both
-- ---- directions and deletes the object after the run) ----
insert into storage.buckets (id, name, public, file_size_limit)
values ('stt-audio', 'stt-audio', false, 262144000)
on conflict (id) do nothing;
