-- The About page's sample poll, and the sample result of it.
--
-- Run by scripts/sample-poll.sh against a throwaway database built from the
-- migrations; it prints the JSON that becomes src/lib/samplePollData.ts. See
-- AGENTS.md, "The sample poll".
--
-- Two things here are deliberate and are the whole reason this is SQL rather
-- than a hand-written fixture:
--
--   * **The poll is built through the app's own write path.** create_poll_group,
--     open_poll_submit and close_poll, in that order, exactly as a creator and
--     nine voters would reach them. A sample that could not have been made by
--     using the site is a sample of something else.
--
--   * **The payloads are what the real functions answer.** open_poll_view,
--     open_poll_results, open_poll_ranking and open_poll_ballots are called
--     here and their output is recorded verbatim. The tie-breaks and runoffs
--     on the About page's sample are therefore the tally's own arithmetic,
--     not a second implementation of STAR written in TypeScript that could
--     quietly disagree with the one that decides real polls.
--
-- Change the ballots below and rerun the script; whatever STAR then makes of
-- them is what the page will show.

\set ON_ERROR_STOP on

create schema if not exists sample;

-- The readable name each question is recorded under: 'sample-movie' and its
-- sibling for the copy still taking votes, 'sample-result-movie' and its
-- sibling for the copy that has finished.
--
-- It used to be the poll's `public_token`, a real column holding a real
-- capability, and readable values were written straight into it. The link to
-- an open poll is now its id, and an id is a uuid, so there is nowhere on the
-- poll to put a word. This table stands in for that column for as long as the
-- script runs: the build records which poll each name belongs to, and the
-- recording below substitutes the name for the uuid in the payloads it
-- prints. What ships is a sample whose questions are reached at
-- `#/sample-movie`, which is a link that can be read out in a talk.
--
-- Nothing in the database is fooled by it. Every payload here is what the
-- real functions answered about the real uuid; the swap happens in the text
-- afterwards, which is also where the poll and group ids have always been
-- made deterministic.
create table if not exists sample.link (
  poll_id uuid primary key,
  name text not null unique
);

-- ---------------------------------------------------------------------------
-- The poll
-- ---------------------------------------------------------------------------
--
-- Three questions, each asking more of the reader than the one before:
--
--   movie   a list with a paragraph under each option, and a three-way tie
--           for the second finalist slot, settled on five-star votes:
--           Paddington 2 has two, the other two one each. Those two fives are
--           Diego's and Gina's, who are cool on Knives Out where most of the
--           room likes it, as is Hugo, who would rather see The Matrix: so the
--           fractional winners give Paddington 2 and The Matrix shares of their
--           own rather than handing the whole evening to Knives Out. Multiple
--           winners and the full ranking also disagree here -- The Matrix takes
--           the second spot, Paddington 2 the second place.
--
--           It is also the *Sequential variant* example: weighed as though
--           last month's movie night had gone to the Knives Out fans
--           (`example_given`, the stars each gave last month's winners),
--           Ana, Ben, Chloe, Erin, Farid and Iris count for less, and
--           Paddington 2 wins the runoff on weight.
--   snacks  an option assignment: one snack each, with only so much of each
--           (`places`). Gina and Iris both most want the one tub of ice
--           cream; the draw gives it to Iris, and Gina gets the gummy bears
--           she gave 4. Everybody else gets a 5.
--
--           It is also the *Budget variant* example: with the prices written
--           down (`cost`) and 20 to spend, counted as proportional winners,
--           the cheap gummy bears go first, then popcorn, chocolate and the
--           pretzels, and 2 is left.
--   when    a different ballot altogether: a calendar, painted rather than
--           scored, asking for the consensus time -- the window whose
--           least-keen voter is keenest -- since a meeting is a choice
--           everybody has to live with. It is last because it is the most to
--           take in.
--
--           Its ten options are the four-hour windows that fit inside a Friday
--           evening and a Saturday daytime -- one on the Friday, nine on the
--           Saturday -- which is the point of asking about two days at once:
--           the two are not the same question and the grid says so. The nine
--           ballots are what nine painted calendars flatten to (a window
--           scores the mean of its half hours; see `scoresFromPainting`):
--           Chloe is busy until eleven on Saturday, Erin from two, Gina keen
--           only on the morning. STAR elects 9:00, which most of the room
--           likes best; the consensus is 10:00, the one window nobody rates
--           below 4.
--
-- The nine voters are the same nine in every question.
create or replace function sample.poll() returns jsonb language sql immutable as $$
select $json${
  "title": "Movie night",
  "voters": ["Ana", "Ben", "Chloe", "Diego", "Erin", "Farid", "Gina", "Hugo", "Iris"],
  "questions": [
    {
      "slug": "movie",
      "title": "What are we watching?",
      "example_given": { "Ana": 9, "Ben": 7, "Chloe": 6, "Diego": 1, "Erin": 9, "Farid": 6, "Gina": 0, "Hugo": 2, "Iris": 6 },
      "options": [
        { "name": "Knives Out", "description": "When renowned crime novelist Harlan Thrombey is found dead at his estate just after his 85th birthday, the inquisitive and debonair Detective Benoit Blanc is mysteriously enlisted to investigate." },
        { "name": "Spirited Away", "description": "During her family's move to the suburbs, a sullen 10-year-old girl wanders into a world ruled by gods, witches and spirits, and where humans are changed into beasts." },
        { "name": "The Matrix", "description": "A computer hacker discovers that his life is nothing more than an elaborate simulation run by an evil AI." },
        { "name": "Paddington 2", "description": "Paddington, now happily settled with the Brown family and a popular member of the local community, picks up a series of odd jobs to buy the perfect present for his Aunt Lucy's 100th birthday, only for the gift to be stolen." },
        { "name": "Mean Girls", "description": "Cady Heron is a hit with The Plastics, the A-list girl clique at her new school, until she makes the mistake of falling for Aaron Samuels, the ex-boyfriend of alpha Plastic Regina George." },
        { "name": "Honeyland", "description": "The last female bee-hunter in Europe must save the bees and return the natural balance in Honeyland, when a family of nomadic beekeepers invade her land and threaten her livelihood." }
      ],
      "ballots": [
        [5, 4, 3, 2, 1, 0],
        [4, 3, 5, 2, 1, 1],
        [4, 5, 2, 3, 0, 5],
        [2, 2, 4, 5, 1, 0],
        [5, 4, 2, 3, 2, 1],
        [3, 3, 4, 2, 2, 2],
        [2, 2, 1, 5, 2, 0],
        [1, 3, 3, 2, 1, 1],
        [3, 0, 2, 2, 2, 1]
      ]
    },
    {
      "slug": "snacks",
      "title": "What snack do you want?",
      "kind": "assignment",
      "budget": 20,
      "options": [
        { "name": "Popcorn", "places": 3, "cost": 6, "description": "A big bowl of buttered popcorn, enough for three." },
        { "name": "Nachos", "places": 2, "cost": 8, "description": "Tortilla chips under melted cheese and salsa, enough for two." },
        { "name": "Chocolate", "places": 2, "cost": 5, "description": "A slab of milk chocolate, enough for two." },
        { "name": "Ice cream", "places": 1, "cost": 9, "description": "A tub of vanilla ice cream, for one." },
        { "name": "Gummy bears", "places": 2, "cost": 4, "description": "A bag of gummy bears, enough for two." },
        { "name": "Pretzels", "places": 1, "cost": 3, "description": "A bag of salted pretzels, for one." }
      ],
      "ballots": [
        [5, 3, 4, 2, 1, 2],
        [5, 4, 2, 3, 1, 1],
        [4, 1, 5, 3, 2, 0],
        [2, 5, 1, 1, 4, 3],
        [5, 2, 3, 4, 1, 1],
        [3, 5, 1, 2, 3, 4],
        [1, 2, 3, 5, 4, 0],
        [4, 3, 2, 1, 5, 2],
        [2, 1, 3, 5, 2, 3]
      ]
    },
    {
      "slug": "when",
      "title": "When are we meeting?",
      "kind": "consensus",
      "schedule": {
        "timezone": "-07:00",
        "window": { "start": "09:00", "end": "22:00" },
        "desired_slots": 8,
        "granularity": 30
      },
      "options": [
        { "name": "2026-02-20T18:00:00-07:00" },
        { "name": "2026-02-21T09:00:00-07:00" },
        { "name": "2026-02-21T09:30:00-07:00" },
        { "name": "2026-02-21T10:00:00-07:00" },
        { "name": "2026-02-21T10:30:00-07:00" },
        { "name": "2026-02-21T11:00:00-07:00" },
        { "name": "2026-02-21T11:30:00-07:00" },
        { "name": "2026-02-21T12:00:00-07:00" },
        { "name": "2026-02-21T12:30:00-07:00" },
        { "name": "2026-02-21T13:00:00-07:00" }
      ],
      "ballots": [
        [5, 4, 4, 4, 4, 4, 4, 4, 4, 4],
        [0, 5, 5, 5, 5, 5, 5, 5, 5, 5],
        [5, 3, 3, 4, 4, 5, 5, 5, 5, 5],
        [2, 5, 4, 4, 4, 3, 3, 2, 2, 1],
        [0, 5, 5, 5, 4, 4, 3, 3, 2, 1],
        [4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
        [0, 4, 4, 4, 3, 3, 2, 2, 2, 2],
        [1, 5, 4, 4, 4, 4, 4, 4, 4, 4],
        [0, 4, 4, 4, 4, 5, 5, 5, 5, 5]
      ]
    }
  ]
}$json$::jsonb
$$;

-- ---------------------------------------------------------------------------
-- Building one copy of it
-- ---------------------------------------------------------------------------

-- Creates the poll and files the readable name of each question in
-- sample.link. No uuid begins with `sample-`, so neither prefix can ever
-- collide with a real poll's id, which is what lets the browser tell a sample
-- link from a poll link by looking at it (see src/lib/samplePoll.ts).
--
-- p_vote decides which copy this is: with the ballots cast and the poll
-- closed, or empty and open. Everything else about the two is identical,
-- because they are meant to be read as one poll seen at two moments.
create or replace function sample.build(
  p_prefix text, p_description text, p_vote boolean,
  p_poll jsonb default sample.poll())
returns void language plpgsql as $$
declare
  v_poll jsonb := p_poll;
  v_group_id uuid;
  v_first uuid;
  v_question jsonb;
  v_question_id uuid;
  v_name text;
  v_candidates uuid[];
  v_scores jsonb;
  v_names text[];
  q int;
  i int;
  j int;
begin
  perform tests.sign_in('sample@example.com');

  v_first := create_poll_group(
    v_poll ->> 'title',
    p_description,
    -- `kind` and `schedule` ride with each question, which is what lets one of
    -- them be a calendar; see 0056_schedule_options.sql. A question that is not
    -- one sends neither, and create_poll_group defaults it to an ordinary poll
    -- exactly as it always did.
    (select jsonb_agg(
              jsonb_build_object('title', x ->> 'title', 'options', x -> 'options')
              || jsonb_strip_nulls(
                   jsonb_build_object(
                     'kind', x -> 'kind',
                     'kind_value', x -> 'kind_value',
                     'schedule', x -> 'schedule'))
            order by ord)
     from jsonb_array_elements(v_poll -> 'questions') with ordinality as t(x, ord)),
    null,
    'open',
    true,   -- show_voters: the sample is a poll with nothing to hide, and the
    true    -- show_ballots: published ballots are half of what it is showing.
  );

  select group_id into v_group_id from polls where id = v_first;

  -- The name each question is recorded under. Nothing about the poll itself
  -- is edited behind the app's back -- this is a note on the side, not a
  -- column of the poll.
  for q in 0 .. jsonb_array_length(v_poll -> 'questions') - 1 loop
    insert into sample.link (poll_id, name)
    select id, p_prefix || '-' || (v_poll -> 'questions' -> q ->> 'slug')
    from polls
    where group_id = v_group_id and question_position = q + 1;
  end loop;

  -- Option ids, made a function of that name and the option's place in the
  -- list rather than left random. They are the keys every payload below is
  -- written in terms of, and a fresh set of them on every run would rewrite
  -- the whole generated file each time it was regenerated. Safe to do here
  -- and nowhere later: no ballot has been cast yet, so nothing refers to them.
  update candidates c
  set id = md5('option:' || l.name || ':' || c.sort_order)::uuid
  from polls p
  join sample.link l on l.poll_id = p.id
  where p.id = c.poll_id and p.group_id = v_group_id;

  if not p_vote then
    return;
  end if;

  select array_agg(v #>> '{}' order by ord)
  into v_names
  from jsonb_array_elements(v_poll -> 'voters') with ordinality as t(v, ord);

  -- Strangers holding the link, nobody signed in. Signed in, every ballot
  -- would carry the one account and it would have one ballot per question.
  perform tests.sign_out();

  for q in 0 .. jsonb_array_length(v_poll -> 'questions') - 1 loop
    v_question := v_poll -> 'questions' -> q;
    v_name := p_prefix || '-' || (v_question ->> 'slug');
    select poll_id into v_question_id from sample.link where name = v_name;

    select array_agg(c.id order by c.sort_order)
    into v_candidates
    from candidates c
    where c.poll_id = v_question_id;

    for i in 1 .. array_length(v_names, 1) loop
      v_scores := '[]'::jsonb;
      for j in 1 .. array_length(v_candidates, 1) loop
        v_scores := v_scores || jsonb_build_array(jsonb_build_object(
          'candidate_id', v_candidates[j],
          'score', (v_question -> 'ballots' -> (i - 1) -> (j - 1))::int
        ));
      end loop;

      -- One key per voter per question, which is exactly how the app mints
      -- them: an open poll's ballots are deliberately not linkable across
      -- questions.
      perform open_poll_submit(
        v_question_id, v_scores, md5(v_names[i] || ':' || v_name), v_names[i]);
    end loop;
  end loop;

  perform tests.sign_in('sample@example.com');
  perform close_poll(v_first);
end $$;

-- ---------------------------------------------------------------------------
-- Recording what the server says about it
-- ---------------------------------------------------------------------------

-- Every payload the public voting page asks for, per share token, exactly as
-- the RPCs answer them. The three that only a finished poll has are asked for
-- only of the finished copy; on the open one they would (rightly) raise.
create or replace function sample.payload() returns text language plpgsql as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_text text;
  v_poll polls;
  v_name text;
  v_entry jsonb;
  v_json jsonb;
begin
  -- Read as the page's reader is: a stranger holding the link, signed out.
  -- Signed in, the group would carry that account's marks.
  perform tests.sign_out();

  for v_poll in
    select p.* from polls p
    join sample.link l on l.poll_id = p.id
    order by l.name
  loop
    v_entry := jsonb_build_object(
      'view', open_poll_view(v_poll.id, 'sample-reader'),
      'group', open_poll_group(v_poll.id)
    );

    if v_poll.closed_at is not null then
      v_entry := v_entry || jsonb_build_object(
        'results', open_poll_results(v_poll.id),
        'ranking', open_poll_ranking(v_poll.id),
        'multiple_winners', open_poll_multiple_winners(v_poll.id, '{}'),
        'fractional_winners', open_poll_fractional_winners(v_poll.id, '{}'),
        'consensus', open_poll_consensus(v_poll.id, '{}'),
        -- At the number a *More results* modal opens on (consensusWinnersFor):
        -- three, or one fewer than the options.
        'consensus_winners', open_poll_consensus_winners(v_poll.id, '{}',
          greatest(2, least(3, (select count(*)::int - 1 from candidates where poll_id = v_poll.id)))),
        'scores', open_poll_scores(v_poll.id),
        'ballots', open_poll_ballots(v_poll.id)
      );

      -- Only an assignment question has places to fill.
      if v_poll.kind = 'assignment' then
        v_entry := v_entry || jsonb_build_object(
          'assignment', open_poll_assignment(v_poll.id, '{}'));
      end if;

      -- The two variant examples, each made as the *More results* menu makes
      -- it. A question with a budget written down (the snacks) is counted with
      -- the *Budget variant*: its options at their costs, proportionally.
      v_json := (select x from jsonb_array_elements(sample.poll() -> 'questions') x
                 where (select name from sample.link where poll_id = v_poll.id)
                       = 'sample-result-' || (x ->> 'slug'));
      if v_json ? 'budget' then
        v_entry := v_entry || jsonb_build_object(
          'budget', open_poll_budget(v_poll.id, '{}',
            (select jsonb_object_agg(c.id, (v_json -> 'options' -> c.sort_order ->> 'cost')::numeric)
             from candidates c where c.poll_id = v_poll.id),
            (v_json ->> 'budget')::numeric, 'multiple'));
      end if;

      -- A question with earlier stars written down (the film) is weighed with
      -- the *Sequential variant*: every ballot at the N its voter is given,
      -- and everything the page reads recorded under those weights, as
      -- poll_sequential sets them.
      if v_json ? 'example_given' then
        perform set_config('app.sequential_given', jsonb_build_object(
          'poll', v_poll.id,
          'given', (select jsonb_object_agg(b.id, (v_json -> 'example_given' ->> b.voter_name)::numeric)
                    from ballots b where b.poll_id = v_poll.id))::text, true);
        v_entry := v_entry || jsonb_build_object('sequential', jsonb_build_object(
          'results', open_poll_results(v_poll.id),
          'ranking', open_poll_ranking(v_poll.id),
          'multiple_winners', open_poll_multiple_winners(v_poll.id, '{}'),
          'scores', open_poll_scores(v_poll.id),
          'ballots', open_poll_ballots(v_poll.id)));
        perform set_config('app.sequential_given', '', true);
      end if;
    end if;

    v_out := v_out || jsonb_build_object(
      (select name from sample.link where poll_id = v_poll.id), v_entry);
  end loop;

  v_text := jsonb_pretty(v_out);

  -- Every poll id in the payloads, swapped for the readable name the question
  -- is recorded under. This is what makes the sample's links readable: the id
  -- IS the link now, so `sample-movie` in this text is what the browser puts in
  -- the address bar and what `open_poll_group` hands back as the next
  -- question. It cannot be done in the database -- every ballot and option
  -- points at the real uuid by the time the poll is built -- so it is done in
  -- the recording, which is where the ids were already being made
  -- deterministic before there was anything readable to make them.
  --
  -- Group ids are not links and nothing navigates by them, so they only have
  -- to be stable; they stay a function of the name rather than becoming it.
  for v_poll in
    select p.* from polls p join sample.link l on l.poll_id = p.id
  loop
    select name into v_name from sample.link where poll_id = v_poll.id;
    v_text := replace(v_text, v_poll.id::text, v_name);

    if v_poll.question_position = 1 then
      v_text := replace(
        v_text,
        v_poll.group_id::text,
        md5('group:' || v_name)::uuid::text
      );
    end if;
  end loop;

  return v_text;
end $$;

do $$
begin
  perform sample.build(
    'sample',
    'A simple sample poll, so you can see what voting looks like. Submitting your vote won''t do anything.',
    false
  );
  perform sample.build(
    'sample-result',
    'An example of the results from a poll. Nine people voted on a film, a snack each and a time to meet.',
    true
  );
end $$;

-- The moment the finished copy stopped taking votes, pinned so that
-- regenerating the file changes it only where the poll changed. Nothing on
-- the public page renders this -- `is_closed` is what it reads -- and pinning
-- it is the difference between a diff of three lines and a diff of none.
update polls set closed_at = timestamptz '2026-02-13 21:37:00+00' where closed_at is not null;

\pset tuples_only on
\pset format unaligned
select sample.payload();
