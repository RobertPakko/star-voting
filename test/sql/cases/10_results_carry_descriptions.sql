-- An option's description outlives the ballot it was written for.
--
-- Descriptions are how an option says what it actually is, and the ballot
-- used to be the only screen that ever showed one. A poll that closes with
-- "Option B" winning should still be able to say what Option B was, so the
-- tally carries the text back out with the totals -- for every option,
-- whether or not it has one, and only ever the text that was stored.

begin;

do $$
declare
  v_poll uuid;
  v_options uuid[];
  v_tally jsonb;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Lunch', null,
                        array['Apple', 'Banana'],
                        array['voter1@example.com'],
                        'invite', true, false,
                        array['Granny Smith', null]);

  select array_agg(id order by sort_order) into v_options
  from candidates where poll_id = v_poll;

  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, jsonb_build_array(
    jsonb_build_object('candidate_id', v_options[1], 'score', 5),
    jsonb_build_object('candidate_id', v_options[2], 'score', 3)));

  perform tests.sign_in('creator@example.com');
  v_tally := poll_tally(v_poll);

  perform tests.assert_eq('the winner still says what it was',
    (select o->>'description' from jsonb_array_elements(v_tally->'options') o
      where o->>'name' = 'Apple'),
    'Granny Smith');
  perform tests.assert_null('an option with no description carries none',
    (select o->>'description' from jsonb_array_elements(v_tally->'options') o
      where o->>'name' = 'Banana'));

  -- The key is present on every option either way: a results page reading
  -- it does not have to tell "no description" apart from "older tally".
  perform tests.assert_eq('every option is asked the question',
    (select count(*)::int from jsonb_array_elements(v_tally->'options') o
      where o ? 'description'),
    2);

  -- The placings name options and nothing else. A paragraph beside a
  -- placing is noise, and the score round has already given it once.
  perform tests.assert_eq('the ranking stays a list of names',
    (select count(*)::int
       from jsonb_array_elements(v_tally->'ranking') r,
            jsonb_array_elements(r->'options') o
      where o ? 'description'),
    0);
end $$;

rollback;
