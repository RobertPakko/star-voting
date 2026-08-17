-- A poll nobody voted in has no result to report. The tally has to say so
-- rather than return a shape the results page would render as a real
-- election with every option on zero.

begin;

do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Nobody voted', null,
                        array['Apple', 'Banana'],
                        array['voter1@example.com'],
                        'invite', true, false);

  perform tests.assert_raises('the tally refuses a poll with no ballots',
    format('select poll_tally(%L)', v_poll),
    'No votes were cast');
end $$;

rollback;
