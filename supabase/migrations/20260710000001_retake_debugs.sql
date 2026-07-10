-- Private bucket for Retake-Aware Beta debug dumps (a copy of the transcription
-- + the cuts each run proposes), collected so detection mistakes can be reviewed
-- and corrected against real data. Authenticated users write only under their own
-- uid folder; the project owner reads everything via the dashboard / service role.
insert into storage.buckets (id, name, public, file_size_limit)
values ('retake-aware-debugs', 'retake-aware-debugs', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "retake-debugs: authenticated insert" on storage.objects;
create policy "retake-debugs: authenticated insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'retake-aware-debugs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "retake-debugs: read own" on storage.objects;
create policy "retake-debugs: read own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'retake-aware-debugs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
