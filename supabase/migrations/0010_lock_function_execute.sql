-- Postgres grants EXECUTE on new functions to PUBLIC by default, so every
-- earlier `grant execute ... to authenticated` was additive noise: the anon
-- role could already call all of these. Verified against the deployed API --
-- an unauthenticated POST to /rpc/list_polls returned 200, not 403.
--
-- Nothing leaked, because each function re-derives identity from the JWT and
-- a null identity matches no poll (list_polls returns [], the rest raise).
-- But these are SECURITY DEFINER: they run as the table owner and bypass
-- RLS, so anon reachability is one forgotten check away from being a real
-- escalation. Lock execution to authenticated callers.
--
-- Trigger functions are deliberately untouched: they take and return the
-- `trigger` pseudo-type, so PostgREST cannot invoke them, and trigger firing
-- does not consult EXECUTE privileges.

revoke execute on function submit_ballot(uuid, jsonb) from public, anon;
revoke execute on function poll_status(uuid) from public, anon;
revoke execute on function get_poll_results(uuid) from public, anon;
revoke execute on function is_poll_creator(uuid) from public, anon;
revoke execute on function is_invited_to_poll(uuid) from public, anon;
revoke execute on function close_poll(uuid) from public, anon;
revoke execute on function poll_invitees(uuid) from public, anon;
revoke execute on function create_poll(text, text, text[], text[]) from public, anon;
revoke execute on function list_polls() from public, anon;

-- Re-assert the intended grants (a revoke from PUBLIC does not touch these,
-- but stating them keeps the end state readable in one place).
grant execute on function submit_ballot(uuid, jsonb) to authenticated;
grant execute on function poll_status(uuid) to authenticated;
grant execute on function get_poll_results(uuid) to authenticated;
grant execute on function is_poll_creator(uuid) to authenticated;
grant execute on function is_invited_to_poll(uuid) to authenticated;
grant execute on function close_poll(uuid) to authenticated;
grant execute on function poll_invitees(uuid) to authenticated;
grant execute on function create_poll(text, text, text[], text[]) to authenticated;
grant execute on function list_polls() to authenticated;
