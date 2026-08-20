-- An open poll's share link names no email address.
--
-- open_poll_view() is the whole of what the public voting page can ask, so
-- what it returns is what a share link discloses -- and a share link goes
-- wherever it is forwarded, to people who never signed in and never will.
--
-- Every email address this app displays anywhere is displayed to somebody
-- already in the poll it belongs to: an invite poll's roster is read by its
-- invitees, and nobody else can see the poll at all. This function is the one
-- place that boundary could be crossed by accident, by returning one more
-- column of `polls` than the page needs. It was crossed once on the way to
-- this case, which is why the case exists.

begin;

do $$
declare
  v_poll uuid;
  v_token text;
  v_scores jsonb;
  v_view jsonb;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Movie night', 'Pick one', array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, true);
  select public_token into v_token from polls where id = v_poll;

  v_view := open_poll_view(v_token);
  perform tests.assert_null('the link does not name who made the poll',
    v_view -> 'poll' ->> 'created_by_email');
  perform tests.assert_eq('though it says everything else about its terms',
    v_view -> 'poll' ->> 'title', 'Movie night');

  -- The poll shows its voters, and those names are still no email address:
  -- an open poll's roster is typed into the ballot by the voters themselves.
  select jsonb_agg(jsonb_build_object('candidate_id', id,
                                      'score', case when name = 'Dune' then 5 else 1 end))
  into v_scores from candidates where poll_id = v_poll;
  perform open_poll_submit(v_token, v_scores, 'voter-key-1', 'Robin');

  v_view := open_poll_view(v_token);
  perform tests.assert_eq('a named voter is named by what they typed',
    v_view -> 'voters' ->> 0, 'Robin');
  perform tests.assert_null('and the creator is still not named at all',
    v_view -> 'poll' ->> 'created_by_email');

  -- Nor once the poll is over and the whole tally is public.
  perform close_poll(v_poll);
  perform tests.assert_eq('the results are out',
    (open_poll_view(v_token) ->> 'results_available')::boolean, true);
  perform tests.assert_null('and name nobody either',
    open_poll_view(v_token) -> 'poll' ->> 'created_by_email');
end $$;

rollback;
