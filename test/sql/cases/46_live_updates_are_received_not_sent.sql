-- Live updates are received by clients and sent only by the database.
--
-- A public Realtime channel lets any client broadcast on it, and one of this
-- app's messages -- `poll_deleted` -- is acted on without a read. So every
-- message goes out on a private channel, clients may only receive on one, and
-- the one internal sender a client could reach through the API is closed.
-- See 0085.
--
-- What is checked is the shape the Realtime service authorizes against: the
-- flag on each message and the policies on realtime.messages. Whether the
-- service honours them is Supabase's half, and is not under test.

begin;

do $$
declare
  v_poll uuid;
begin
  -- ---- every message is private --------------------------------------------

  perform tests.forget_signals();
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 0], [0, 5]]);
  perform tests.assert_eq('a change to a poll announces itself',
    tests.signals(tests.poll_topic(v_poll)) > 0, true);
  perform tests.assert_eq('on a private channel, every time',
    (select bool_and(private) from realtime.messages), true);

  -- ---- clients receive, and nothing more -----------------------------------

  perform tests.assert_eq('one policy lets clients receive broadcasts',
    (select count(*)::int from pg_policies
     where schemaname = 'realtime' and tablename = 'messages'
       and cmd = 'SELECT'
       and roles @> array['anon', 'authenticated']::name[]), 1);
  perform tests.assert_eq('and none lets any client send one',
    (select count(*)::int from pg_policies
     where schemaname = 'realtime' and tablename = 'messages'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')), 0);

  -- ---- the internal sender is not an API ------------------------------------

  perform tests.assert_eq('broadcast_poll_change cannot be called by a reader with no session',
    has_function_privilege('anon', 'public.broadcast_poll_change(uuid)', 'execute'), false);
  perform tests.assert_eq('nor by one signed in',
    has_function_privilege('authenticated', 'public.broadcast_poll_change(uuid)', 'execute'),
    false);
  perform tests.assert_eq('nor announce, as before',
    has_function_privilege('anon', 'public.announce(text, text)', 'execute')
      or has_function_privilege('authenticated', 'public.announce(text, text)', 'execute'),
    false);
end $$;

rollback;
