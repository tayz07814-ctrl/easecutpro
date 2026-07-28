-- Per-user custom fonts: a private storage bucket for the font files plus a
-- metadata table (family name, storage path, chosen default). Both are scoped to
-- the owning user via RLS, mirroring the projects / retake-aware-debugs pattern.

insert into storage.buckets (id, name, public, file_size_limit)
values ('user-fonts', 'user-fonts', false, 10485760)
on conflict (id) do nothing;

-- storage.objects: a user may only touch objects under their own <uid>/ folder.
drop policy if exists "user-fonts: insert own" on storage.objects;
create policy "user-fonts: insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'user-fonts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "user-fonts: read own" on storage.objects;
create policy "user-fonts: read own" on storage.objects for select to authenticated
  using (bucket_id = 'user-fonts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "user-fonts: update own" on storage.objects;
create policy "user-fonts: update own" on storage.objects for update to authenticated
  using (bucket_id = 'user-fonts' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'user-fonts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "user-fonts: delete own" on storage.objects;
create policy "user-fonts: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'user-fonts' and (storage.foldername(name))[1] = auth.uid()::text);

-- metadata table
create table if not exists public.user_fonts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  family text not null,
  path text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, family)
);

alter table public.user_fonts enable row level security;

drop policy if exists "user_fonts: own rows" on public.user_fonts;
create policy "user_fonts: own rows" on public.user_fonts for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.user_fonts to authenticated;
