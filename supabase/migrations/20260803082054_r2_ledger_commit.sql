-- Mark a reserved object as really written. Called by the upload Worker (via the
-- r2-commit edge function) once R2 has accepted the bytes — never by a browser,
-- because a client that simply skipped this step would have its storage stop
-- counting an hour later, which is the whole hole this closes.
create or replace function public.space_commit_object(p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.space_objects
     set state = 'committed', updated_at = now()
   where key = p_key and state <> 'committed';
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.space_commit_object(text) from public;
revoke all on function public.space_commit_object(text) from authenticated;

-- Reserved-but-uncommitted rows now count for 24 h rather than 1 h. A successful
-- upload is committed within seconds, so this window only ever covers genuinely
-- abandoned uploads — and if a commit call is ever lost to a transient failure,
-- the space is over-counted for a day instead of instantly under-counted, which
-- is the direction a quota should fail in.
create or replace function public.space_used_bytes(p_space uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(bytes), 0)::bigint
  from public.space_objects
  where space_id = p_space
    and (state = 'committed' or updated_at > now() - interval '24 hours');
$$;

revoke all on function public.space_used_bytes(uuid) from public;
grant execute on function public.space_used_bytes(uuid) to authenticated;
