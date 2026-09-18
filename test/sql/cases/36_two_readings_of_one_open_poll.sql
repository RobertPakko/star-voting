-- An open poll's creator reads it twice, and one of the readings contains the
-- other.
--
-- `poll_status` is the account's reading of a poll and `open_poll_view` is the
-- link's, and the creator's own page is the one screen that holds both: it
-- draws the poll as an account and votes in it through the link, like everyone
-- else. It used to ask for both on every live tick, which was a round trip for
-- a strict subset of what the other one had already said.
--
-- It now asks for the view alone and works the status out from it, in
-- `statusFromOpenView` (src/lib/pollPage.ts). That translation is only honest
-- for as long as the two functions agree, and nothing in the database makes
-- them: they are two hundred lines apart and share no code beyond the helpers
-- below. So this is the case that holds them together -- field by field, on a
-- poll moved through every state one can be in.
--
-- The four fields the view does not carry are here too, because the browser
-- fills those in as constants and a constant is a claim about this function:
-- an open poll has no invite list, so `invited_count` is 0, `is_complete` and
-- `invited` are false, and `voted` and `confirmed` -- which ask about the
-- *account* -- are false however much that account has done through the link.

begin;

do $$
declare
  v_poll uuid;
  v_status record;
  v_view jsonb;
  v_scores jsonb;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Movie night', null, array[]::text[], array[]::text[],
                        'open', true, false, null, true);

  -- ------------------------------------------------------------------
  -- Collecting its options
  -- ------------------------------------------------------------------

  perform open_poll_suggest_options(v_poll, jsonb_build_array(
    jsonb_build_object('name', 'Dune'), jsonb_build_object('name', 'Arrival')));
  perform open_poll_confirm_options(v_poll, 'voter-key-1', 'Ada');

  select * into v_status from poll_status(v_poll);
  v_view := open_poll_view(v_poll, 'creator-key');

  perform tests.assert_eq('collecting: the same answer about the stage',
    v_status.soliciting, (v_view ->> 'soliciting')::boolean);
  perform tests.assert_eq('collecting: the same count of who is done',
    v_status.confirmed_count, (v_view ->> 'confirmed_count')::int);
  perform tests.assert_eq('collecting: the same count of votes',
    v_status.voted_count, (v_view ->> 'voted_count')::int);
  perform tests.assert_eq('collecting: the same answer about the gate',
    v_status.results_available, (v_view ->> 'results_available')::boolean);

  -- The four the browser fills in for itself. A confirmation went in above
  -- under a browser key, and the account reading cannot see it -- which is the
  -- point: `open_poll_confirm_options` stores no voter_id at all.
  perform tests.assert_eq('an open poll has nobody invited',
    v_status.invited_count, 0);
  perform tests.assert_eq('so it can never be complete',
    v_status.is_complete, false);
  perform tests.assert_eq('and its creator is not on a list',
    v_status.invited, false);
  perform tests.assert_eq('a confirmation through the link is not the account''s',
    v_status.confirmed, false);
  perform tests.assert_eq('though the link itself knows about it',
    (v_view ->> 'confirmed_count')::int, 1);

  -- ------------------------------------------------------------------
  -- Taking votes
  -- ------------------------------------------------------------------

  perform finalize_options(v_poll);

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 4))
  into v_scores from candidates where poll_id = v_poll;
  -- Cast by the creator's own browser, through the link, exactly as the page
  -- does it.
  perform open_poll_submit(v_poll, v_scores, 'creator-key', 'Creator');

  select * into v_status from poll_status(v_poll);
  v_view := open_poll_view(v_poll, 'creator-key');

  perform tests.assert_eq('voting: the same count of votes',
    v_status.voted_count, (v_view ->> 'voted_count')::int);
  perform tests.assert_eq('voting: the same answer about the stage',
    v_status.soliciting, (v_view ->> 'soliciting')::boolean);
  perform tests.assert_eq('voting: neither reading has a result yet',
    v_status.results_available, (v_view ->> 'results_available')::boolean);
  perform tests.assert_eq('a ballot cast through the link is not the account''s',
    v_status.voted, false);
  perform tests.assert_eq('though the link itself knows about it',
    (v_view ->> 'voted')::boolean, true);
  perform tests.assert_eq('and a poll with a vote in it is still not complete',
    v_status.is_complete, false);

  -- ------------------------------------------------------------------
  -- Closed, with a winner settled
  -- ------------------------------------------------------------------

  perform close_poll(v_poll);

  select * into v_status from poll_status(v_poll);
  v_view := open_poll_view(v_poll, 'creator-key');

  perform tests.assert_eq('closed: the same answer about the close',
    v_status.is_closed, (v_view ->> 'is_closed')::boolean);
  perform tests.assert_eq('closed: the same answer about the gate',
    v_status.results_available, (v_view ->> 'results_available')::boolean);
  perform tests.assert_eq('closed: the same winner',
    v_status.winner_name, v_view ->> 'winner_name');
  perform tests.assert_eq('closed: settled in both readings',
    v_status.winner_settled, (v_view ->> 'winner_settled')::boolean);
  perform tests.assert_eq('and settled is what it says',
    v_status.winner_settled, true);

  -- ------------------------------------------------------------------
  -- And the one field only the account reading has
  -- ------------------------------------------------------------------
  --
  -- The browser carries it from the read that opened the page rather than
  -- asking again, which is only safe because nothing moves it. Everything
  -- above has happened to this poll -- options collected, confirmed,
  -- finalized, a vote cast, the poll closed -- and it is still the day it was
  -- created plus the window.

  perform tests.assert_eq('the retention date is the creation date plus the window',
    v_status.expires_at,
    (select created_at + poll_retention_window() from polls where id = v_poll));
  perform tests.assert_null('and the view does not carry it at all',
    v_view ->> 'expires_at');
end $$;

rollback;
