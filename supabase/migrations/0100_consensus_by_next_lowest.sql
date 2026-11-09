-- The consensus breaks a tie on its floor with each tied option's next-lowest
-- score, then the next, and so on (leximin), rather than with STAR. Options
-- level on every score leave no winner, and the reader is offered the coin.
--
-- Every ballot counts. A ballot giving every option 0 adds one 0 to the
-- bottom of every option's scores alike, so it moves every floor to 0 but
-- cannot change which option wins: the comparison passes over it to the next
-- score up.


-- Answers { winner_id, floor, option_count, tied_count, voter_count,
-- decided_at, winner_score, runner_up, level_ids, level_names, options }:
--
--   floor         the highest lowest score: the winner's, or the level
--                 options' where there is no winner
--   tied_count    how many options share that floor
--   decided_at    where the winner pulled ahead, counting each option's
--                 scores lowest first (1: on its lowest score); null with no
--                 winner, or with no other option to beat
--   winner_score  the winner's score at that position
--   runner_up     { id, name, score }: the next option in the order, and its
--                 score at that position
--   level_ids,    the options level on every score, where there is no
--   level_names   winner (two or more); empty otherwise
--   options       the poll_results_rows() first options in the order, the
--                 winner first, each with its floor and total stars
--
-- Two options with the same scores in a different order of ballots are level:
-- the comparison is of what each was given, not of who gave it.
--
-- The reader can take options out (`p_excluded`), as for multiple winners:
-- the count runs as though they had never been on the ballot. Nothing is
-- stored.
CREATE OR REPLACE FUNCTION "public"."poll_consensus"("p_poll_id" "uuid", "p_excluded" "uuid"[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pool uuid[];
  v_voters int;
  v_top record;
  v_second record;
  v_level uuid[];
  v_level_names jsonb := '[]'::jsonb;
  v_tied int;
  v_winner uuid;
  v_at int;
  v_runner_up jsonb;
  v_options jsonb;
begin
  -- A poll has at most a few hundred options; anything longer is not a list
  -- a reader built by pressing buttons.
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  select count(*) into v_voters from ballots where poll_id = p_poll_id;
  if v_voters = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates
  where poll_id = p_poll_id
    and not (id = any(coalesce(p_excluded, '{}'::uuid[])));

  if cardinality(v_pool) = 0 then
    raise exception 'Every option has been left out';
  end if;

  -- Each option's scores, lowest first. Arrays of one length compare element
  -- by element, so ordering by `ladder desc` is the whole comparison. One
  -- score per option per ballot is an invariant (fill_scores_for_new_option),
  -- but a missing score reads as 0, as the tally reads it.
  drop table if exists _consensus;
  create temp table _consensus on commit drop as
  select
    c.id as cid,
    c.name,
    array_agg(coalesce(s.score, 0)::int order by coalesce(s.score, 0)) as ladder,
    coalesce(sum(s.score), 0)::int as total
  from candidates c
  join ballots b on b.poll_id = p_poll_id
  left join scores s on s.ballot_id = b.id and s.candidate_id = c.id
  where c.id = any(v_pool)
  group by c.id, c.name;

  alter table _consensus add column rn bigint;
  update _consensus t set rn = o.rn
  from (select cid, row_number() over (order by ladder desc, name, cid) as rn from _consensus) o
  where o.cid = t.cid;

  select * into v_top from _consensus where rn = 1;
  select * into v_second from _consensus where rn = 2;

  select count(*)::int into v_tied from _consensus where ladder[1] = v_top.ladder[1];

  select array_agg(cid order by rn) into v_level from _consensus where ladder = v_top.ladder;

  if cardinality(v_level) > 1 then
    -- Level on every score: nothing left to compare.
    select jsonb_agg(name order by rn) into v_level_names from _consensus where ladder = v_top.ladder;
  else
    v_winner := v_top.cid;
    v_level := '{}';

    if v_second.cid is not null then
      -- The first position the two differ at; they differ somewhere, or they
      -- would be level.
      v_at := 1;
      while v_top.ladder[v_at] = v_second.ladder[v_at] loop
        v_at := v_at + 1;
      end loop;

      v_runner_up := jsonb_build_object(
        'id', v_second.cid,
        'name', v_second.name,
        'score', v_second.ladder[v_at]
      );
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    'floor', ladder[1],
    'total_score', total
  ) order by rn), '[]'::jsonb)
  into v_options
  from _consensus
  where rn <= poll_results_rows();

  return jsonb_build_object(
    'winner_id', v_winner,
    'floor', v_top.ladder[1],
    'option_count', cardinality(v_pool),
    'tied_count', v_tied,
    'voter_count', v_voters,
    'decided_at', v_at,
    'winner_score', case when v_at is not null then v_top.ladder[v_at] end,
    'runner_up', v_runner_up,
    'level_ids', to_jsonb(v_level),
    'level_names', v_level_names,
    'options', v_options
  );
end;
$$;

