-- One writer at a time per poll (0081).
--
-- A race needs two sessions and this suite is one, so what can be asserted
-- here is the shape that prevents them: every function that reads a poll's
-- state and writes on it takes the poll's lock before anything else, and the
-- lock is internal. A writer added later without it fails this case rather
-- than waiting for two people to press a button in the same instant.
--
-- The races themselves were reproduced against a build with two real
-- sessions -- the last two votes settling nothing, a vote beside Close
-- leaving the badge disagreeing with the tally, a vote beside an added option
-- going in short a score, the last two confirmations never opening the poll
-- -- and each went away with the lock. See "Writers take turns" in AGENTS.md.

begin;

do $$
declare
  v_name text;
  v_src text;
begin
  foreach v_name in array array[
    -- the voters' doors
    'submit_ballot', 'open_poll_submit', 'revise_ballot', 'open_poll_revise',
    'confirm_options', 'open_poll_confirm_options',
    'unconfirm_options', 'open_poll_unconfirm_options',
    'suggest_option', 'suggest_options',
    'open_poll_suggest_option', 'open_poll_suggest_options',
    'open_poll_watch',
    -- the creator's
    'creator_add_option', 'creator_add_options', 'creator_edit_options',
    'finalize_options', 'close_poll', 'reopen_poll', 'send_poll_reminder',
    -- the reconcilers
    'settle_winner', 'notify_results_ready', 'open_options_when_all_confirmed',
    -- and the guards in front of the two tables the browser writes directly
    'guard_invitee_changes', 'guard_options_frozen'
  ] loop
    select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;

    perform tests.assert_eq(v_name || ' takes the poll''s lock before it reads anything',
      -- The first statement after the outermost begin, comments and blank
      -- lines aside: a lock taken after a read is a lock on a stale picture.
      (regexp_match(v_src, E'\\nbegin\\n(?:\\s*(?:--[^\\n]*)?\\n)*\\s*(\\S[^\\n]*)'))[1]
        like 'perform lock_poll(%',
      true);
  end loop;

  perform tests.assert_eq('the lock is not a door of its own',
    has_function_privilege('authenticated', 'public.lock_poll(uuid)', 'execute'), false);
  perform tests.assert_eq('to an account or a link',
    has_function_privilege('anon', 'public.lock_poll(uuid)', 'execute'), false);
end $$;

rollback;
