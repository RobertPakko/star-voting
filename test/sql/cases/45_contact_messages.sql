-- The contact page's messages: who may send one, what is refused, and that
-- nobody but the service role can read them back.

begin;

do $$
declare
  v_count int;
begin
  -- ---- who may send, and who may read --------------------------------------

  perform tests.assert_eq('a reader with no session may send a message',
    has_function_privilege('anon', 'public.send_contact_message(text, text)', 'execute'), true);
  perform tests.assert_eq('and so may one signed in',
    has_function_privilege('authenticated', 'public.send_contact_message(text, text)', 'execute'),
    true);
  perform tests.assert_eq('but neither can read the messages',
    has_table_privilege('anon', 'public.contact_messages', 'select')
      or has_table_privilege('authenticated', 'public.contact_messages', 'select'), false);
  perform tests.assert_eq('or write to the table past the function',
    has_table_privilege('anon', 'public.contact_messages', 'insert')
      or has_table_privilege('authenticated', 'public.contact_messages', 'insert'), false);

  -- ---- a message goes in ---------------------------------------------------

  perform tests.sign_out();
  perform send_contact_message('  stranger@example.com ', '  The calendar is lovely.  ');
  perform tests.assert_eq('signed out, the message is stored, trimmed',
    (select message from contact_messages where email = 'stranger@example.com'),
    'The calendar is lovely.');
  perform tests.assert_null('with nobody recorded as sending it',
    (select user_id from contact_messages where email = 'stranger@example.com'));

  perform tests.sign_in('voter1@example.com');
  perform send_contact_message('reply@example.com', 'A bug.');
  perform tests.assert_eq('signed in, the account is recorded beside the reply address',
    (select user_id from contact_messages where email = 'reply@example.com'), auth.uid());

  -- ---- what is refused -----------------------------------------------------

  perform tests.assert_raises('a blank address',
    $q$ select send_contact_message('  ', 'Hello') $q$, 'Enter an email address');
  perform tests.assert_raises('something that is not an address',
    $q$ select send_contact_message('not an address', 'Hello') $q$, 'does not look like');
  perform tests.assert_raises('a blank message',
    $q$ select send_contact_message('a@example.com', '   ') $q$, 'Write a message');
  perform tests.assert_raises('a message over the limit',
    $q$ select send_contact_message('a@example.com', repeat('x', 5001)) $q$, 'at most 5000');

  -- One sent above; four more fill the day, and the sixth is refused.
  for i in 1..4 loop
    perform send_contact_message('reply@example.com', 'More ' || i);
  end loop;
  perform tests.assert_raises('one account, five messages a day',
    $q$ select send_contact_message('reply@example.com', 'One too many') $q$,
    'several messages today');

  -- And the table as a whole, which is the only bound on a caller with no
  -- session: fill the hour, and the next message from anybody is refused.
  perform tests.sign_out();
  select count(*) into v_count from contact_messages where created_at > now() - interval '1 hour';
  insert into contact_messages (email, message)
  select 'flood@example.com', 'x' from generate_series(1, 100 - v_count);
  perform tests.assert_raises('a hundred messages an hour, from everybody together',
    $q$ select send_contact_message('late@example.com', 'Hello') $q$, 'in the last hour');
end $$;

rollback;
