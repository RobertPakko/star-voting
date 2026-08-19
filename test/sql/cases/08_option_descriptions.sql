-- Option descriptions are optional, and land on the option they were typed
-- against.
--
-- The create form drops blank option rows before submitting, but a poll built
-- by hand can still send one, and the descriptions arrive as a second array
-- paired with the first by position. Dropping a blank without dropping its
-- slot in that pairing would slide every later description one option up --
-- which is not an error anywhere, just the wrong text under the wrong name.

begin;

do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Lunch', null,
                        array['Apple', '', 'Banana', 'Cherry'],
                        array['voter1@example.com'],
                        'invite', true, false,
                        array['Granny Smith', 'ignored', null, '   ']);

  perform tests.assert_eq('the first option keeps its description',
    (select description from candidates where poll_id = v_poll and name = 'Apple'),
    'Granny Smith');
  perform tests.assert_null('the blank row does not shift descriptions along',
    (select description from candidates where poll_id = v_poll and name = 'Banana'));
  perform tests.assert_null('a whitespace-only description is stored as nothing',
    (select description from candidates where poll_id = v_poll and name = 'Cherry'));
  perform tests.assert_eq('the blank option itself is still dropped',
    (select count(*)::int from candidates where poll_id = v_poll), 3);

  -- Most polls describe nothing, and the argument can be left off entirely.
  v_poll := create_poll('Dinner', null,
                        array['Soup', 'Salad'],
                        array['voter1@example.com'],
                        'invite', true, false);

  perform tests.assert_eq('a poll created without descriptions has none',
    (select count(*)::int from candidates where poll_id = v_poll and description is not null), 0);
end $$;

rollback;
