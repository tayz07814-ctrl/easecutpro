-- delta_debug was world-readable/writable via the anon key (RLS off + default
-- grants). Writes go through log_delta_debug (SECURITY DEFINER, execute granted
-- only to service_role/postgres) and reads happen via the dashboard, so no
-- client access is needed at all: enable RLS with no policies and drop the
-- direct grants. service_role/postgres carry BYPASSRLS, so the edge-function
-- writer keeps working.
alter table public.delta_debug enable row level security;
revoke all on table public.delta_debug from anon, authenticated;
