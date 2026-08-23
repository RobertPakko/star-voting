-- A poll that asks more than one question.
--
-- The shape under test: several ordinary polls sharing a group, a title, an
-- invite list and their settings. Each question keeps its own options,
-- ballots and tally; what the group owns is the invitation, the reveal and
-- the lifecycle.

begin;

do $$
declare
  v_questions uuid[];
  v_q1 uuid;
  v_q2 uuid;
  v_listed record;
  v_status record;
  v_group jsonb;
begin
  v_questions := tests.seed_group(
    array[
      row('Where should we eat?', array['Pizza', 'Salad', 'Curry'])::tests.question,
      row('What time?',           array['Noon', 'One'])::tests.question
    ],
    array['voter1@example.com', 'voter2@example.com']);

  v_q1 := v_questions[1];
  v_q2 := v_questions[2];

  -- ---- the rows themselves -------------------------------------------------

  perform tests.assert_eq('a two-question poll is two polls',
    array_length(v_questions, 1), 2);

  perform tests.assert_eq('they share one group',
    (select count(distinct group_id)::int from polls where id = any(v_questions)), 1);

  perform tests.assert_eq('and are numbered in order',
    (select array_agg(question_position order by question_position)::int[]
       from polls where id = any(v_questions)),
    array[1, 2]);

  perform tests.assert_eq('the poll title is shared',
    (select count(distinct title)::int from polls where id = any(v_questions)), 1);

  perform tests.assert_eq('the question titles are not',
    (select question_title from polls where id = v_q2), 'What time?');

  perform tests.assert_eq('each question has its own options',
    (select count(*)::int from candidates where poll_id = v_q1), 3);
  perform tests.assert_eq('and its own shorter list',
    (select count(*)::int from candidates where poll_id = v_q2), 2);

  perform tests.assert_eq('every question carries the whole invite list',
    (select count(*)::int from invited_voters where poll_id = v_q2), 2);

  -- ---- one row on the poll list --------------------------------------------

  perform tests.sign_in('creator@example.com');

  perform tests.assert_eq('the list shows the poll once, not once per question',
    (select count(*)::int from list_polls(10, 0)), 1);

  select * into v_listed from list_polls(10, 0);

  perform tests.assert_eq('the row is the first question', v_listed.id, v_q1);
  perform tests.assert_eq('and it says how many questions there are',
    v_listed.question_count, 2);
  perform tests.assert_eq('and carries the first question''s own title',
    v_listed.question_title, 'Where should we eat?');

  -- ---- the reveal waits for the whole poll ---------------------------------

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_q1, array[5, 1, 0]);
  perform tests.cast_ballot(v_q2, array[5, 0]);

  perform tests.sign_in('voter2@example.com');
  perform tests.cast_ballot(v_q1, array[4, 2, 0]);

  -- Everyone invited has now answered question 1, which on a single-question
  -- poll is the whole of the reveal rule.
  select * into v_status from poll_status(v_q1);
  perform tests.assert_eq('question 1 has taken every ballot', v_status.is_complete, true);
  perform tests.assert_eq('but its results are not out',
    v_status.results_available, false);
  perform tests.assert_raises('and cannot be read',
    format('select get_poll_results(%L)', v_q1),
    'Results are not available until everyone has voted');

  perform tests.cast_ballot(v_q2, array[3, 5]);

  select * into v_status from poll_status(v_q1);
  perform tests.assert_eq('the last ballot in the poll opens question 1',
    v_status.results_available, true);

  select * into v_status from poll_status(v_q2);
  perform tests.assert_eq('and question 2 with it', v_status.results_available, true);

  -- ---- each question is its own election -----------------------------------

  perform tests.assert_eq('question 1 elects from its own options',
    tests.winner(poll_tally(v_q1)), 'Pizza');
  -- Noon 8, One 5; the runoff splits 1-1 on preference and falls to the
  -- score. The whole STAR machinery runs per question, on that question's
  -- ballots alone.
  perform tests.assert_eq('question 2 from its own',
    tests.winner(poll_tally(v_q2)), 'Noon');
  perform tests.assert_eq('settled by the score, its runoff having tied',
    poll_tally(v_q2) #>> '{runoff,resolved_by}', 'higher_score');
  perform tests.assert_eq('and counts only its own ballots',
    (poll_tally(v_q2) ->> 'voter_count')::int, 2);

  -- ---- the strip that walks them -------------------------------------------

  perform tests.sign_in('voter1@example.com');
  v_group := poll_group(v_q1);

  perform tests.assert_eq('the group lists both questions',
    jsonb_array_length(v_group), 2);
  perform tests.assert_eq('in the order they are asked',
    v_group -> 1 ->> 'question_title', 'What time?');
  perform tests.assert_eq('and says this reader has answered them',
    (v_group -> 0 ->> 'voted')::boolean, true);
end $$;

rollback;


-- Closing and clearing act on the poll, not on one question of it.
begin;

do $$
declare
  v_questions uuid[];
  v_q1 uuid;
  v_q2 uuid;
begin
  v_questions := tests.seed_group(
    array[
      row('First', array['A', 'B'])::tests.question,
      row('Second', array['C', 'D'])::tests.question
    ],
    array['voter1@example.com', 'voter2@example.com']);

  v_q1 := v_questions[1];
  v_q2 := v_questions[2];

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_q1, array[5, 0]);
  perform tests.cast_ballot(v_q2, array[0, 5]);

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_q1);

  perform tests.assert_eq('closing the poll closes every question',
    (select count(*)::int from polls
      where id = any(v_questions) and closed_at is not null), 2);

  perform tests.assert_eq('so a half-answered poll still reveals what it has',
    (select results_available from poll_status(v_q1)), true);

  -- Question 2 was answered by the same one voter, so it has a tally too;
  -- a question nobody answered would say so instead, which is the point of
  -- asking "has anyone answered" of the question and not of the group.
  perform tests.assert_eq('and so does the other question',
    (select results_available from poll_status(v_q2)), true);

  perform tests.assert_raises('closing it again is refused once, for the poll',
    format('select close_poll(%L)', v_q2),
    'This poll is already closed');

  perform reset_poll(v_q2);

  perform tests.assert_eq('resetting clears every question''s ballots',
    (select count(*)::int from ballots where poll_id = any(v_questions)), 0);
  perform tests.assert_eq('and reopens every question',
    (select count(*)::int from polls
      where id = any(v_questions) and closed_at is not null), 0);
end $$;

rollback;


-- What the group does not change.
begin;

do $$
declare
  v_poll uuid;
begin
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 0], [4, 1]]);

  perform tests.sign_in('creator@example.com');

  perform tests.assert_null('a poll that asks one question has no group',
    (select group_id from polls where id = v_poll));
  perform tests.assert_null('and no question title either',
    (select question_title from polls where id = v_poll));
  perform tests.assert_eq('and its group reads as empty, not as a group of one',
    jsonb_array_length(poll_group(v_poll)), 0);
  perform tests.assert_eq('it still appears on the list',
    (select count(*)::int from list_polls(10, 0) where id = v_poll), 1);
  perform tests.assert_eq('counted as the single question it is',
    (select question_count from list_polls(10, 0) where id = v_poll), 1);

  perform tests.assert_raises('a group of one is refused',
    'select create_poll_group(''T'', null, ''[{"title":"Only","options":[{"name":"A"},{"name":"B"}]}]''::jsonb, array[''voter1@example.com''])',
    'A multi-question poll needs at least two questions');

  perform tests.assert_raises('an untitled question is refused',
    'select create_poll_group(''T'', null, ''[{"title":"","options":[{"name":"A"},{"name":"B"}]},{"title":"Second","options":[{"name":"C"},{"name":"D"}]}]''::jsonb, array[''voter1@example.com''])',
    'Question 1 needs a title');

  perform tests.assert_raises('and so is a question with one option',
    'select create_poll_group(''T'', null, ''[{"title":"First","options":[{"name":"A"}]},{"title":"Second","options":[{"name":"C"},{"name":"D"}]}]''::jsonb, array[''voter1@example.com''])',
    'Add at least two options');
end $$;

rollback;


-- The share-link side: one poll, one token per question.
begin;

do $$
declare
  v_questions uuid[];
  v_t1 text;
  v_t2 text;
  v_group jsonb;
  v_view jsonb;
begin
  v_questions := tests.seed_group(
    array[
      row('Where should we eat?', array['Pizza', 'Salad'])::tests.question,
      row('What time?',           array['Noon', 'One'])::tests.question
    ],
    array[]::text[], 'Lunch', 'open');

  select public_token into v_t1 from polls where id = v_questions[1];
  select public_token into v_t2 from polls where id = v_questions[2];

  perform tests.assert_eq('every question gets its own share token',
    (select count(distinct public_token)::int from polls where id = any(v_questions)), 2);

  -- Holding one token reaches the rest of the poll; that is what makes the
  -- next question reachable from a link to the first.
  v_group := open_poll_group(v_t1);
  perform tests.assert_eq('one token reaches every question',
    jsonb_array_length(v_group), 2);
  perform tests.assert_eq('and hands back the next one''s token',
    v_group -> 1 ->> 'token', v_t2);
  perform tests.assert_eq('with what it asks',
    v_group -> 1 ->> 'question_title', 'What time?');

  -- Nothing here says who answered what. The keys are minted per question so
  -- that one browser's ballots cannot be joined, and this must not undo it.
  perform tests.assert_eq('and says nothing about who has answered',
    v_group -> 0 ? 'voted', false);

  -- ---- voting question by question ----------------------------------------

  perform open_poll_submit(v_t1, tests.open_scores(v_questions[1], array[5, 0]), 'key-a-1', 'Ada');
  perform open_poll_submit(v_t2, tests.open_scores(v_questions[2], array[0, 5]), 'key-a-2', 'Ada');

  perform tests.assert_eq('a ballot lands on the question it was cast in',
    (select count(*)::int from ballots where poll_id = v_questions[1]), 1);

  -- The same name on both is two unrelated rows, which is the whole point:
  -- the questions are separate polls and nothing joins one ballot to the next.
  perform tests.assert_raises('one ballot per question, per key',
    format('select open_poll_submit(%L, %s, %L, %L)',
           v_t1, quote_literal(tests.open_scores(v_questions[1], array[1, 1])) || '::jsonb',
           'key-a-1', 'Ada'),
    'You have already voted in this poll');

  perform open_poll_submit(v_t1, tests.open_scores(v_questions[1], array[0, 5]), 'key-b-1', 'Bo');
  perform open_poll_submit(v_t1, tests.open_scores(v_questions[1], array[4, 1]), 'key-c-1', 'Cy');

  -- ---- the reveal still waits for the whole poll ---------------------------

  v_view := open_poll_view(v_t1, 'key-a-1');
  perform tests.assert_eq('a question of an open poll stays sealed while it is open',
    (v_view ->> 'results_available')::boolean, false);
  perform tests.assert_eq('and knows which question it is',
    v_view -> 'poll' ->> 'question_title', 'Where should we eat?');
  perform tests.assert_eq('and that it belongs to a poll of several',
    (v_view -> 'poll' -> 'group_id') is not null, true);

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_questions[2]);

  v_view := open_poll_view(v_t1, 'key-a-1');
  perform tests.assert_eq('closing from any question opens all of them',
    (v_view ->> 'results_available')::boolean, true);

  -- Pizza 9, Salad 6; two of the three prefer Pizza, so the runoff settles
  -- outright. The election is the same one it has always been, run on this
  -- question's ballots and no others.
  perform tests.assert_eq('and each question elects from its own ballots',
    tests.winner(poll_tally(v_questions[1])), 'Pizza');
  perform tests.assert_eq('on its own three voters',
    (poll_tally(v_questions[1]) ->> 'voter_count')::int, 3);
  perform tests.assert_eq('while question 2 took only the one',
    (poll_tally(v_questions[2]) ->> 'voter_count')::int, 1);
end $$;

rollback;


-- Collecting options for a poll that asks several questions.
--
-- Each question gathers its own list, because a suggestion lands against a
-- poll id and that is what a question is. Opening is one act over all of
-- them, for the same reason closing is.
begin;

do $$
declare
  v_first uuid;
  v_questions uuid[];
  v_q1 uuid;
  v_q2 uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_first := create_poll_group(
    'Team offsite', null,
    '[{"title":"Where?","options":[{"name":"Coast"},{"name":"Mountains"}]},
      {"title":"When?","options":[]}]'::jsonb,
    array['voter1@example.com'], 'invite', true, false, true);

  v_questions := tests.group_questions(v_first);
  v_q1 := v_questions[1];
  v_q2 := v_questions[2];

  perform tests.assert_eq('a soliciting group may start with almost nothing',
    (select count(*)::int from candidates where poll_id = v_q2), 0);
  perform tests.assert_eq('and every question is collecting',
    (select bool_and(soliciting) from poll_status(v_q1)), true);

  -- ---- the floor is asked of every question, before any of them opens ----
  --
  -- Question 1 already clears it. Opening is refused all the same, and named
  -- on the question that does not -- not on the one the creator happened to
  -- press the button from, and not on the first in the poll.

  perform tests.assert_raises('a question still short refuses the whole poll',
    format('select finalize_options(%L)', v_q1),
    'Add at least two options');
  perform tests.assert_raises('and says which question is short',
    format('select finalize_options(%L)', v_q1),
    'When?');

  perform tests.assert_eq('nothing was opened by the attempt',
    (select count(*)::int from polls
      where id = any(v_questions) and options_finalized_at is not null), 0);

  -- ---- voters fill the lists in, question by question --------------------

  perform tests.sign_in('voter1@example.com');
  perform suggest_option(v_q1, 'Desert');
  perform suggest_option(v_q2, 'June');
  perform suggest_option(v_q2, 'September');

  perform tests.assert_eq('suggestions land on the question they were made in',
    (select count(*)::int from candidates where poll_id = v_q2), 2);
  perform tests.assert_eq('and not on its neighbour',
    (select count(*)::int from candidates where poll_id = v_q1), 3);

  -- ---- opening is one act ------------------------------------------------

  perform tests.sign_in('creator@example.com');
  perform finalize_options(v_q2);

  perform tests.assert_eq('opening the poll opens every question',
    (select count(*)::int from polls
      where id = any(v_questions) and options_finalized_at is not null), 2);

  perform tests.assert_eq('so none of them is still collecting',
    (select soliciting from poll_status(v_q1)), false);

  perform tests.assert_raises('and the lists are closed for good',
    format('select suggest_option(%L, %L)', v_q1, 'Desert'),
    'settled and voting has started');

  perform tests.assert_raises('there being nothing left to open twice',
    format('select finalize_options(%L)', v_q1),
    'already been finalized');

  -- Voting now works on every question, which is the whole point of opening
  -- them together rather than one at a time.
  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_q1, array[5, 0, 2]);
  perform tests.cast_ballot(v_q2, array[0, 5]);

  perform tests.assert_eq('every question takes votes at once',
    (select count(*)::int from ballots where poll_id = any(v_questions)), 2);
end $$;

rollback;
