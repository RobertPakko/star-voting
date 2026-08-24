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

-- ---------------------------------------------------------------------------
-- The poll
-- ---------------------------------------------------------------------------
--
-- Three questions, each one harder to settle than the last:
--
--   host    a plain election. The score leader wins the runoff too, and there
--           is nothing to explain beyond the two rounds themselves.
--   dinner  the runoff overturns the score round. Taco bar leads on points
--           because the four voters who want it want it badly; pizza wins
--           because five of the nine prefer it, which is the whole reason
--           STAR runs a runoff at all.
--   movie   a three-way tie for the second finalist slot, settled head to
--           head, with one of the three pairs itself tied.
--
-- The nine voters are the same nine in every question, and three of them are
-- the hosts on offer in the first one.
create or replace function sample.poll() returns jsonb language sql immutable as $$
select $json${
  "title": "Movie night",
  "voters": ["Ana", "Ben", "Chloe", "Diego", "Erin", "Farid", "Gina", "Hugo", "Iris"],
  "questions": [
    {
      "slug": "host",
      "title": "Who's hosting?",
      "options": [
        { "name": "Ana's place" },
        { "name": "Ben's loft" },
        { "name": "Chloe's basement" }
      ],
      "ballots": [
        [5, 2, 3],
        [2, 5, 3],
        [2, 1, 5],
        [3, 2, 5],
        [4, 1, 4],
        [2, 3, 5],
        [3, 2, 4],
        [4, 0, 5],
        [1, 2, 4]
      ]
    },
    {
      "slug": "dinner",
      "title": "What are we eating?",
      "options": [
        { "name": "Two big pizzas", "description": "One pepperoni, one cheese." },
        { "name": "Taco bar", "description": "Build your own tacos!" },
        { "name": "Everyone brings a dish" },
        { "name": "Thai delivery", "description": "Will take like 40 minutes to get here, we can have an intermission rather than eating beforehand." },
        { "name": "Just snacks", "description": "Popcorn, chips, whatever." }
      ],
      "ballots": [
        [1, 5, 2, 3, 1],
        [2, 5, 1, 2, 0],
        [3, 5, 3, 2, 1],
        [2, 5, 2, 1, 2],
        [4, 3, 2, 3, 1],
        [5, 2, 1, 4, 1],
        [5, 4, 3, 2, 1],
        [4, 3, 2, 2, 1],
        [4, 3, 2, 3, 1]
      ]
    },
    {
      "slug": "movie",
      "title": "What are we watching?",
      "options": [
        { "name": "Knives Out", "description": "When renowned crime novelist Harlan Thrombey is found dead at his estate just after his 85th birthday, the inquisitive and debonair Detective Benoit Blanc is mysteriously enlisted to investigate." },
        { "name": "Spirited Away", "description": "During her family's move to the suburbs, a sullen 10-year-old girl wanders into a world ruled by gods, witches and spirits, and where humans are changed into beasts." },
        { "name": "The Matrix", "description": "A computer hacker discovers that his life is nothing more than an elaborate simulation run by an evil AI." },
        { "name": "Paddington 2", "description": "Paddington, now happily settled with the Brown family and a popular member of the local community, picks up a series of odd jobs to buy the perfect present for his Aunt Lucy's 100th birthday, only for the gift to be stolen." },
        { "name": "Whatever is trending", "description": "Cady Heron is a hit with The Plastics, the A-list girl clique at her new school, until she makes the mistake of falling for Aaron Samuels, the ex-boyfriend of alpha Plastic Regina George." },
        { "name": "Honeyland", "description": "The last female bee-hunter in Europe must save the bees and return the natural balance in Honeyland, when a family of nomadic beekeepers invade her land and threaten her livelihood." }
      ],
      "ballots": [
        [5, 4, 3, 2, 1, 0],
        [4, 3, 5, 2, 1, 1],
        [4, 5, 2, 3, 0, 5],
        [3, 2, 4, 5, 1, 0],
        [5, 4, 2, 3, 2, 1],
        [3, 3, 4, 2, 2, 2],
        [4, 2, 1, 5, 2, 0],
        [2, 3, 3, 2, 1, 1],
        [3, 0, 2, 2, 2, 1]
      ]
    }
  ]
}$json$::jsonb
$$;

-- ---------------------------------------------------------------------------
-- Building one copy of it
-- ---------------------------------------------------------------------------

-- Creates the poll under readable share tokens: 'sample-host' and its two
-- siblings for the copy still taking votes, 'sample-result-host' and its two
-- for the copy that has finished. A real token is 32 hex digits, so neither
-- prefix can ever collide with one, which is what lets the browser tell a
-- sample link from a poll link by looking at it (see src/lib/samplePoll.ts).
--
-- p_vote decides which copy this is: with the ballots cast and the poll
-- closed, or empty and open. Everything else about the two is identical,
-- because they are meant to be read as one poll seen at two moments.
create or replace function sample.build(p_prefix text, p_description text, p_vote boolean)
returns void language plpgsql as $$
declare
  v_poll jsonb := sample.poll();
  v_group_id uuid;
  v_first uuid;
  v_question jsonb;
  v_token text;
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
    (select jsonb_agg(jsonb_build_object('title', x ->> 'title', 'options', x -> 'options')
            order by ord)
     from jsonb_array_elements(v_poll -> 'questions') with ordinality as t(x, ord)),
    null,
    'open',
    true,   -- show_voters: the sample is a poll with nothing to hide, and the
    true    -- show_ballots: published ballots are half of what it is showing.
  );

  select group_id into v_group_id from polls where id = v_first;

  -- The generated tokens, swapped for readable ones. Nothing else about the
  -- poll is edited behind the app's back.
  for q in 0 .. jsonb_array_length(v_poll -> 'questions') - 1 loop
    update polls
    set public_token = p_prefix || '-' || (v_poll -> 'questions' -> q ->> 'slug')
    where group_id = v_group_id and question_position = q + 1;
  end loop;

  -- Option ids, made a function of the token and the option's place in the
  -- list rather than left random. They are the keys every payload below is
  -- written in terms of, and a fresh set of them on every run would rewrite
  -- the whole generated file each time it was regenerated. Safe to do here
  -- and nowhere later: no ballot has been cast yet, so nothing refers to them.
  update candidates c
  set id = md5('option:' || p.public_token || ':' || c.sort_order)::uuid
  from polls p
  where p.id = c.poll_id and p.group_id = v_group_id;

  if not p_vote then
    return;
  end if;

  select array_agg(v #>> '{}' order by ord)
  into v_names
  from jsonb_array_elements(v_poll -> 'voters') with ordinality as t(v, ord);

  for q in 0 .. jsonb_array_length(v_poll -> 'questions') - 1 loop
    v_question := v_poll -> 'questions' -> q;
    v_token := p_prefix || '-' || (v_question ->> 'slug');

    select array_agg(c.id order by c.sort_order)
    into v_candidates
    from candidates c
    join polls p on p.id = c.poll_id
    where p.public_token = v_token;

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
      perform open_poll_submit(v_token, v_scores, md5(v_names[i] || ':' || v_token), v_names[i]);
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
  v_entry jsonb;
begin
  for v_poll in
    select * from polls
    where public_token like 'sample-%'
    order by public_token
  loop
    v_entry := jsonb_build_object(
      'view', open_poll_view(v_poll.public_token, 'sample-reader'),
      'group', open_poll_group(v_poll.public_token)
    );

    if v_poll.closed_at is not null then
      v_entry := v_entry || jsonb_build_object(
        'results', open_poll_results(v_poll.public_token),
        'ranking', open_poll_ranking(v_poll.public_token),
        'ballots', open_poll_ballots(v_poll.public_token)
      );
    end if;

    v_out := v_out || jsonb_build_object(v_poll.public_token, v_entry);
  end loop;

  v_text := jsonb_pretty(v_out);

  -- Poll and group ids, made a function of the token for the same reason the
  -- option ids above are. They could not be rewritten in place -- every ballot
  -- and option points at them by then -- so they are rewritten in the
  -- recording instead.
  for v_poll in select * from polls where public_token like 'sample-%' loop
    v_text := replace(
      v_text,
      v_poll.id::text,
      md5('poll:' || v_poll.public_token)::uuid::text
    );

    if v_poll.question_position = 1 then
      v_text := replace(
        v_text,
        v_poll.group_id::text,
        md5('group:' || v_poll.public_token)::uuid::text
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
    'An example of the results from a poll. Nine people voted, and each question was harder to settle than the one before it.',
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
