-- Server-owned R2 object ledger — makes the storage quota actually enforceable.
--
-- The quota was computed by summing space_projects.media_bytes, but that column
-- is written by the CLIENT (cowork.ts updates it after each upload, and RLS lets
-- any editor member do so). So the check was "how much storage would you like to
-- admit to?" — upload 10 TB, never update the number, quota reads zero forever.
--
-- This table is the authority instead. Only the service role touches it, from
-- the r2-sign edge function at the moment a write is authorised. One row per
-- object key, so re-uploading the same key REPLACES its size rather than adding
-- to it (an overwrite doesn't grow storage, and the ledger must agree).
--
-- space_projects.media_bytes stays for display; it is no longer trusted.

create table if not exists public.space_objects (
  space_id   uuid not null references public.spaces(id) on delete cascade,
  -- full R2 key, e.g. spaces/<space>/projects/<p>/media/<m>
  key        text not null,
  bytes      bigint not null default 0 check (bytes >= 0),
  -- 'reserved' = authorised but the upload may not have happened yet.
  -- 'committed' = the bytes are really in the bucket.
  state      text not null default 'reserved' check (state in ('reserved', 'committed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (space_id, key)
);

create index if not exists space_objects_space_idx on public.space_objects (space_id);
create index if not exists space_objects_stale_idx on public.space_objects (state, updated_at);

alter table public.space_objects enable row level security;

-- No policies for `authenticated` on purpose: with RLS on and no policy, every
-- client read and write is denied. The service role bypasses RLS, so only the
-- edge function can touch this. That is the whole point — the number the quota
-- is built from must be one the client cannot reach.
drop policy if exists "objects: no client access" on public.space_objects;

-- Bytes currently charged to a space. A 'reserved' row older than an hour is a
-- write that was authorised and never happened (tab closed, upload failed), so
-- it stops counting and the space isn't permanently billed for a ghost.
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
    and (state = 'committed' or updated_at > now() - interval '1 hour');
$$;

-- Members may READ their space's true usage (for the storage chip in the UI).
revoke all on function public.space_used_bytes(uuid) from public;
grant execute on function public.space_used_bytes(uuid) to authenticated;

-- Reserve space for one object, atomically, refusing to exceed the quota.
-- Returns the row count of the space after the change; raises on quota.
create or replace function public.space_reserve_object(p_space uuid, p_key text, p_bytes bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quota bigint;
  v_used  bigint;
  v_prev  bigint;
begin
  select quota_bytes into v_quota from public.spaces where id = p_space;
  if v_quota is null then
    raise exception 'no such space';
  end if;

  -- What this key already costs — an overwrite replaces, it doesn't add.
  select coalesce(bytes, 0) into v_prev
  from public.space_objects where space_id = p_space and key = p_key;
  v_prev := coalesce(v_prev, 0);

  v_used := public.space_used_bytes(p_space);

  if (v_used - v_prev + p_bytes) > v_quota then
    raise exception 'quota_exceeded' using errcode = 'check_violation';
  end if;

  insert into public.space_objects (space_id, key, bytes, state, updated_at)
  values (p_space, p_key, p_bytes, 'reserved', now())
  on conflict (space_id, key)
  do update set bytes = excluded.bytes, state = 'reserved', updated_at = now();

  return v_used - v_prev + p_bytes;
end;
$$;

-- Service role only: the edge function calls this, never a browser.
revoke all on function public.space_reserve_object(uuid, text, bigint) from public;
revoke all on function public.space_reserve_object(uuid, text, bigint) from authenticated;

-- Backfill so existing spaces don't read as empty and blow past their quota.
-- One synthetic row per project carrying whatever media_bytes last claimed;
-- real per-object rows replace it as each object is next written.
insert into public.space_objects (space_id, key, bytes, state)
select p.space_id, 'legacy/' || p.id::text, greatest(0, coalesce(p.media_bytes, 0)), 'committed'
from public.space_projects p
where coalesce(p.media_bytes, 0) > 0
on conflict (space_id, key) do nothing;
