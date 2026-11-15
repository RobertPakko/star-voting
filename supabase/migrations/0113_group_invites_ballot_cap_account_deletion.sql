-- Five things, none of which changes a result anybody has read:
--
--   1. an invite list is changed across every question of a poll at once;
--   2. each question says how many ballots it holds, so the creator's
--      controls can ask about the whole poll;
--   3. an open question takes a bounded number of ballots;
--   4. an account can be deleted, and anonymous accounts nobody is using are;
--   5. the weighted STAR round is linear in the ballots rather than quadratic.


-- ---------------------------------------------------------------------------
-- 1. The invite list belongs to the poll, not to the question on screen
-- ---------------------------------------------------------------------------
--
-- Every question of a group carries the whole invite list: the row-level
-- security on its options and ballots reads it, and so does the gate that
-- decides when the results are out. The browser used to insert into
-- invited_voters for the one question it was showing, which left the new
-- voter invited to that question alone -- not emailed unless it was the
-- first, not able to answer the others, and holding the results back until
-- they found the one they could.
--
-- So the list is changed through two functions that walk the group, and the
-- direct grant goes: a list that can only be written whole cannot be written
-- lopsided.

CREATE OR REPLACE FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_poll polls;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_question uuid;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  -- The same 'not found' a poll that exists but isn't yours gets everywhere
  -- else.
  if not found then
    raise exception 'Poll not found';
  end if;

  -- The shape invited_voters_email_ck holds the table to, said in words
  -- before the constraint can say it in its own.
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'That does not look like an email address';
  end if;

  -- First question first, which is the one the invitation is sent about; see
  -- trg_send_invite_email. An address already on a question is left as it
  -- is, so inviting somebody again completes a list that was left lopsided
  -- rather than refusing to touch it. Everything else -- an open poll, a
  -- closed one, results that are out, the ceilings -- is
  -- guard_invitee_changes', asked of every row.
  --
  -- Asked first rather than left to `on conflict`: the guard is a BEFORE
  -- trigger, and would count an invitation for a row that was never written.
  for v_question in select q.id from poll_group_members(v_poll) q loop
    if not exists (
      select 1 from invited_voters where poll_id = v_question and email = v_email
    ) then
      insert into invited_voters (poll_id, email) values (v_question, v_email);
    end if;
  end loop;
end;
$_$;


ALTER FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text") IS 'Adds one address to the creator''s own poll, on every question of it, and invites them once. The only way onto an invite list after the poll is made.';



CREATE OR REPLACE FUNCTION "public"."uninvite_voter"("p_poll_id" "uuid", "p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Poll not found';
  end if;

  -- One statement, so the triggers that reconcile the poll afterwards -- the
  -- winner, the results notice -- see the list as it ends up rather than
  -- part-way. guard_invitee_changes refuses the lot if they have voted in
  -- any question: a ballot that is counted cannot be honestly un-counted,
  -- and somebody left on the questions they answered and off the rest is the
  -- lopsided list this function exists to prevent.
  delete from invited_voters
  where poll_id in (select q.id from poll_group_members(v_poll) q)
    and email = v_email;
end;
$$;


ALTER FUNCTION "public"."uninvite_voter"("p_poll_id" "uuid", "p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."uninvite_voter"("p_poll_id" "uuid", "p_email" "text") IS 'Takes one address off the creator''s own poll, on every question of it. Refused whole if they have voted in any question.';


REVOKE ALL ON FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."uninvite_voter"("p_poll_id" "uuid", "p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."uninvite_voter"("p_poll_id" "uuid", "p_email" "text") TO "authenticated";

-- Nothing writes the table directly any more, so nothing may.
REVOKE INSERT, DELETE ON TABLE "public"."invited_voters" FROM "authenticated";
DROP POLICY IF EXISTS "invited_voters_insert" ON "public"."invited_voters";
DROP POLICY IF EXISTS "invited_voters_delete" ON "public"."invited_voters";


-- The guard, with one line changed: whether the results are out is asked of
-- the poll rather than of the question. Asked of the question, a poll whose
-- first question everybody had answered refused a new voter while its second
-- was still taking votes -- and a new voter is added to both. A poll that
-- asks one question is answered exactly as before: closed is refused above,
-- and its gate is otherwise open only on full turnout.

CREATE OR REPLACE FUNCTION "public"."guard_invitee_changes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll_id uuid;
  v_poll polls;
  v_invited int;
  v_sent int;
begin
  perform lock_poll(case when tg_op = 'DELETE' then old.poll_id else new.poll_id end);

  if tg_op = 'DELETE' then
    v_poll_id := old.poll_id;
  else
    v_poll_id := new.poll_id;
  end if;

  select * into v_poll from polls where id = v_poll_id;

  -- Parent poll already gone => cascade from deleting the poll itself.
  if not found then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'INSERT' then
    if v_poll.mode <> 'invite' then
      raise exception 'This poll is open to anyone with the link, so it has no invitee list';
    end if;

    if v_poll.closed_at is not null then
      raise exception 'Cannot invite people to a poll that has been closed';
    end if;

    -- Every question's gate, which is what poll_results_revealed asks: the
    -- results of a poll of several questions are out when all of them have
    -- stopped, and until then somebody added can still answer all of them.
    if (select bool_and(poll_gate_open(q.*)) from poll_group_members(v_poll) q) then
      raise exception 'Cannot invite people once the results have been revealed';
    end if;

    select count(*) into v_invited from invited_voters where poll_id = v_poll_id;

    if v_invited >= 500 then
      raise exception 'A poll can invite 500 people';
    end if;

    -- The day's count, for whoever is inviting. Each question of a group
    -- carries the whole list and only the first is emailed, so only the
    -- first counts. Nobody signed in is the database's own work.
    if auth.uid() is not null and poll_is_first_question(v_poll_id) then
      delete from invitations_sent
      where account_id = auth.uid() and day < current_date;

      insert into invitations_sent (account_id, day, sent)
      values (auth.uid(), current_date, 1)
      on conflict (account_id, day) do update set sent = invitations_sent.sent + 1
      returning sent into v_sent;

      if v_sent > 1000 then
        raise exception 'That is as many invitations as one account can send in a day';
      end if;
    end if;

    return new;
  end if;

  if exists (
    select 1
    from ballots b
    join auth.users u on u.id = b.voter_id
    where b.poll_id = v_poll_id and lower(u.email) = old.email
  ) then
    raise exception 'Cannot remove someone who has already voted';
  end if;

  return old;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. How many ballots each question holds
-- ---------------------------------------------------------------------------
--
-- Closing and reopening act on the whole poll, and the creator's page was
-- deciding whether to offer them from the one question on screen: a poll
-- whose first question everybody had answered and whose second nobody had
-- offered Close on neither. `voted_count` per question is what lets the page
-- ask the poll. A count names nobody, and poll_status already gives it to
-- the same readers one question at a time.

CREATE OR REPLACE FUNCTION "public"."poll_group"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
begin
  -- The same visibility test the rest of the invite side applies: the poll
  -- is yours, or you were invited to it. Every question in a group carries
  -- the same invite list, so seeing one is seeing all of them.
  select p.* into v_poll
  from polls p
  where p.id = p_poll_id
    and (
      p.created_by = auth.uid()
      or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
    );

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.group_id is null then
    return '[]'::jsonb;
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id,
      'question_position', q.question_position,
      'question_title', q.question_title,
      -- What the creator's "Open poll" button needs to apply the floor
      -- finalize_options applies, rather than offering a button that is
      -- refused: opening is one act over every question, so the button has
      -- to know about every question's list and not just this one's.
      'option_count', (select count(*)::int from candidates c where c.poll_id = q.id),
      -- And what "Close poll" and "Reopen poll" need, for the same reason:
      -- they are one act over every question too.
      'voted_count', (select count(*)::int from ballots b where b.poll_id = q.id),
      -- Which questions this reader has already answered. Free on this side:
      -- an invite ballot carries the voter's account, so nothing has to be
      -- linked to find them -- and so does an open ballot its creator cast
      -- signed in, which is the one reader of an open poll this function
      -- serves. See open_poll_group for the share-link side.
      'voted', exists (
        select 1 from ballots b
        where b.poll_id = q.id and (b.voter_id = auth.uid() or b.account_id = auth.uid())
      ),
      -- And which they have finished adding to, which is the same mark for
      -- the stage before the ballot. Free for the same reason. False rather
      -- than null for a creator who is not on the invite list: they have no
      -- confirmation to give, and the strip draws no mark for one they could
      -- not have made.
      'confirmed', exists (
        select 1 from option_confirmations oc
        where oc.poll_id = q.id and (oc.voter_id = auth.uid() or oc.account_id = auth.uid())
      )
    ) order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;


COMMENT ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") IS 'The questions of the poll this one belongs to, in order, with how many options and ballots each holds, whether the reader has answered each and whether they have finished adding options to each; empty for a poll that asks one question.';


-- ---------------------------------------------------------------------------
-- 3. An open question takes a bounded number of ballots
-- ---------------------------------------------------------------------------
--
-- An invite poll is bounded by its list. An open one was bounded by nothing:
-- anybody holding the link can vote again under a fresh key, and every count
-- is at least linear in the scores it reads, so past a point a result stops
-- answering inside a request.
--
-- Two ceilings, whichever is lower:
--
--   * 2000 ballots, above which the option assignment refuses outright;
--   * 250,000 scores (ballots x options), which is what the largest invite
--     poll can hold: 500 invitees scoring 500 options. So a calendar of 500
--     windows takes 500 votes, and any list of 125 options or fewer takes
--     the full 2000.
--
-- The check is new, and the option count is read before it rather than
-- after; the rest is the function as it was.

CREATE OR REPLACE FUNCTION "public"."open_poll_submit"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_name text;
  v_key text;
  v_ballot_id uuid;
  v_option_count int;
  v_cast int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
  v_given numeric;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if v_poll.solicit_options and v_poll.options_finalized_at is null then
    raise exception 'This poll is still collecting options, so voting has not started';
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  if v_poll.show_voters then
    v_name := nullif(trim(coalesce(p_voter_name, '')), '');
    if v_name is null then
      raise exception 'Enter your name so the group can see who has voted';
    end if;
    if length(v_name) > 60 then
      raise exception 'That name is too long';
    end if;
  else
    -- A poll that hides respondents must not store one, whatever the client
    -- sends.
    v_name := null;
  end if;

  -- This reader's ballot, however they are known: by their account on
  -- another device, or by this browser's key. See open_ballot_of.
  if open_ballot_of(v_poll.id, p_voter_key) is not null then
    raise exception 'You have already voted in this poll';
  end if;

  -- After "you have already voted", so somebody who has is told that rather
  -- than this. Changing a vote is another door and is never refused here.
  select count(*) into v_cast from ballots where poll_id = v_poll.id;
  select count(*) into v_option_count from candidates where poll_id = v_poll.id;

  if v_cast >= 2000 or v_cast >= 250000 / greatest(v_option_count, 1) then
    raise exception 'This poll has as many votes as it can count';
  end if;

  -- The key goes on the ballot unless another account's ballot already holds
  -- it -- a shared browser, the next person signed in. Their ballot is found
  -- by their account, so it needs no key, and a key cannot be on two ballots.
  v_key := p_voter_key;
  if exists (select 1 from ballots where poll_id = v_poll.id and voter_key = p_voter_key) then
    v_key := null;
  end if;

  if jsonb_array_length(p_scores) is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  -- A sequential question matches the name the reader gave, even on a poll
  -- that hides names: there the name finds the weight and is then thrown
  -- away, as every name on such a poll is.
  v_given := claim_carried_weight(v_poll.id, p_voter_name);

  begin
    insert into ballots (poll_id, voter_id, account_id, voter_name, voter_key, given)
    values (v_poll.id, null, auth.uid(), v_name, v_key, v_given)
    returning id into v_ballot_id;
  exception when unique_violation then
    -- Either the name is taken, or this reader raced themselves (a
    -- double-click, or two devices at once) past the check above.
    if v_name is null or open_ballot_of(v_poll.id, p_voter_key) is not null then
      raise exception 'You have already voted in this poll';
    end if;
    raise exception '"%" has already voted in this poll. Add a last initial if that is not you.', v_name;
  end;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_candidate_id := (v_item ->> 'candidate_id')::uuid;
    v_score := (v_item ->> 'score')::int;

    if v_score < 0 or v_score > 5 then
      raise exception 'Score must be between 0 and 5';
    end if;

    if not exists (select 1 from candidates where id = v_candidate_id and poll_id = v_poll.id) then
      raise exception 'Invalid option for this poll';
    end if;

    insert into scores (ballot_id, candidate_id, score) values (v_ballot_id, v_candidate_id, v_score);
  end loop;

  -- As in submit_ballot, and for the same reason. An open poll reveals only
  -- on close, so this settles nothing today -- but the gate is read from one
  -- function and this keeps the two ballot paths saying the same thing.
  perform settle_winner(v_poll.id);
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. Accounts can be deleted
-- ---------------------------------------------------------------------------
--
-- Three references to auth.users said nothing about what happens when the
-- user goes, which is Postgres for "refuse": an account that had made a poll
-- or voted in an invite poll could not be deleted until the six-month purge
-- had taken every poll it touched.
--
--   * Its polls go with it, exactly as Delete poll takes them.
--   * Its ballots in other people's polls stay and lose their owner. A
--     result somebody has read does not change because a voter left, and the
--     ballot is counted as it was -- under no name, on a sheet that had one.
--   * Its confirmations go: they only ever said one person was done adding.

ALTER TABLE "public"."polls" DROP CONSTRAINT "polls_created_by_fkey";
ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE "public"."ballots" DROP CONSTRAINT "ballots_voter_id_fkey";
ALTER TABLE ONLY "public"."ballots"
    ADD CONSTRAINT "ballots_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE "public"."option_confirmations" DROP CONSTRAINT "option_confirmations_voter_id_fkey";
ALTER TABLE ONLY "public"."option_confirmations"
    ADD CONSTRAINT "option_confirmations_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


-- And the anonymous accounts nobody is using. "Continue without an account"
-- mints a real auth.users row, a session lost is a row nobody can ever sign
-- in to again, and nothing took them away.
--
-- Deleted only when deleting it loses nothing: older than a poll can be, and
-- with no poll, link ballot or confirmation to its name. A browser still
-- holding that session finds itself signed out, and has nothing it could
-- have come back to.

CREATE OR REPLACE FUNCTION "public"."purge_stale_anonymous_accounts"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deleted int;
begin
  with gone as (
    delete from auth.users u
    where u.is_anonymous
      and u.created_at <= now() - poll_retention_window()
      and not exists (select 1 from polls p where p.created_by = u.id)
      and not exists (select 1 from ballots b where b.account_id = u.id)
      and not exists (select 1 from option_confirmations oc where oc.account_id = u.id)
    returning 1
  )
  select count(*)::int into v_deleted from gone;

  -- What only ever pointed at them and has no foreign key to follow them
  -- out by.
  delete from invitations_sent i
  where not exists (select 1 from auth.users u where u.id = i.account_id);

  delete from account_carry_overs c
  where not exists (select 1 from auth.users u where u.id = c.anon_id);

  return v_deleted;
end;
$$;


ALTER FUNCTION "public"."purge_stale_anonymous_accounts"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."purge_stale_anonymous_accounts"() IS 'Deletes accounts made without signing in that are older than the retention window and own nothing: no poll, no link ballot, no confirmation. Returns how many went. Scheduled nightly by pg_cron.';


REVOKE ALL ON FUNCTION "public"."purge_stale_anonymous_accounts"() FROM PUBLIC;


-- The schedule, which a squash cannot carry: said again in
-- supabase/after-squash.sql, and idempotent in both places.
DO $$
begin
  if to_regnamespace('cron') is null then
    return;
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'purge-stale-anonymous-accounts';

  perform cron.schedule('purge-stale-anonymous-accounts', '47 4 * * *',
    $cron$select public.purge_stale_anonymous_accounts()$cron$);
end $$;


-- ---------------------------------------------------------------------------
-- 5. The weighted round, linear in the ballots
-- ---------------------------------------------------------------------------
--
-- scaled_star_round is every count that weighs a ballot: proportional
-- winners, both budget counts that choose winners, and the whole tally of a
-- sequential question. Its runoff and its two-way tie-break look up one
-- ballot's score for one option at a time, in a temporary table with no
-- index, so each lookup read the whole table and the round took four times
-- as long for twice the ballots: proportional winners over ten options was
-- eight seconds at 500 ballots and half a minute at 1000, which is past any
-- request's timeout. With the index it is under two seconds at 2000.
--
-- One statement is new -- the `create index` after _wscores is filled -- and
-- nothing it returns has changed; the rest is the function as it was.

CREATE OR REPLACE FUNCTION "public"."scaled_star_round"("p_poll_id" "uuid", "p_pool" "uuid"[], "p_ballots" "uuid"[], "p_weights" numeric[], "p_scales" numeric[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_finalists uuid[] := '{}';
  v_pick uuid[];
  v_tiebreaks jsonb := '[]'::jsonb;
  v_need int := 2;
  v_score numeric;
  v_group uuid[];
  v_grp_size int;
  v_tied jsonb;
  v_h2h jsonb;
  v_matchup jsonb;
  v_fs jsonb;
  v_steps jsonb;
  v_advanced jsonb;
  v_resolved text;
  v_fn numeric; v_fn1 numeric;
  v_a uuid; v_b uuid;
  v_ta numeric; v_tb numeric;
  v_fa numeric; v_fb numeric;
  v_prefers_a numeric; v_prefers_b numeric; v_ties numeric;
  v_winner uuid;
  v_runoff_by text;
begin
  drop table if exists _wweights;
  create temp table _wweights on commit drop as
  select b.ballot_id, b.weight
  from unnest(p_ballots, p_weights) as b(ballot_id, weight);

  -- Each option's scale, paired with the pool by position.
  drop table if exists _wscale;
  create temp table _wscale on commit drop as
  select x.cid, x.scale
  from unnest(p_pool, p_scales) as x(cid, scale);

  -- Every ballot's score for every option in the pool, at its strength, and
  -- the option's scale beside it.
  drop table if exists _wscores;
  create temp table _wscores on commit drop as
  select s.ballot_id, s.candidate_id, s.score, w.weight, x.scale
  from scores s
  join _wweights w on w.ballot_id = s.ballot_id
  join _wscale x on x.cid = s.candidate_id
  where s.candidate_id = any(p_pool);

  -- The runoff and the two-way tie-break look one ballot's score for one
  -- option up at a time, once per ballot. Without this each of those is a
  -- scan of the whole table, and the round is quadratic in the ballots.
  create index on _wscores (ballot_id, candidate_id);

  drop table if exists _wround;
  create temp table _wround on commit drop as
  select
    c.id as cid,
    c.name,
    round(coalesce(sum(s.score * s.weight * s.scale), 0), 6) as total,
    round(coalesce(sum(s.weight * s.scale) filter (where s.score = 5), 0), 6) as five_stars
  from candidates c
  left join _wscores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
    and c.id = any(p_pool)
  group by c.id, c.name;

  for v_score in select distinct total from _wround order by total desc loop
    exit when v_need <= 0;

    select array_agg(cid order by cid) into v_group from _wround where total = v_score;
    v_grp_size := coalesce(array_length(v_group, 1), 0);

    if v_grp_size <= v_need then
      v_finalists := v_finalists || v_group;
      v_need := v_need - v_grp_size;
    else
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total) order by name)
        into v_tied from _wround where cid = any(v_group);
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', five_stars) order by five_stars desc, name)
        into v_fs from _wround where cid = any(v_group);

      if v_grp_size = 2 then
        select cid into v_a from _wround where cid = any(v_group) order by name, cid limit 1;
        select cid into v_b from _wround where cid = any(v_group) and cid <> v_a;

        select
          round(coalesce(sum(weight) filter (where a_score > b_score), 0)
                * (select scale from _wscale where cid = v_a), 6),
          round(coalesce(sum(weight) filter (where b_score > a_score), 0)
                * (select scale from _wscale where cid = v_b), 6),
          round(coalesce(sum(weight) filter (where a_score = b_score), 0), 6)
        into v_prefers_a, v_prefers_b, v_ties
        from (
          select
            w.weight,
            coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_a), 0) as a_score,
            coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_b), 0) as b_score
          from _wweights w
        ) v;

        select jsonb_build_object(
                 'a', v_a, 'a_name', ca.name,
                 'b', v_b, 'b_name', cb.name,
                 'prefers_a', v_prefers_a,
                 'prefers_b', v_prefers_b,
                 'ties', v_ties)
          into v_matchup
        from _wround ca, _wround cb
        where ca.cid = v_a and cb.cid = v_b;

        drop table if exists _wtb;
        create temp table _wtb on commit drop as
        with w as (
          select
            t.cid,
            t.name,
            t.five_stars,
            case
              when t.cid = v_a then (v_prefers_a > v_prefers_b)::int
              else (v_prefers_b > v_prefers_a)::int
            end as h2h_wins
          from _wround t
          where t.cid = any(v_group)
        )
        select w.*, row_number() over (order by h2h_wins desc, five_stars desc, cid) as rn
        from w;

        select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', h2h_wins) order by h2h_wins desc, name)
          into v_h2h from _wtb;

        if v_prefers_a <> v_prefers_b then
          v_resolved := 'head_to_head';
        elsif (select max(five_stars) <> min(five_stars) from _wtb) then
          v_resolved := 'five_star_votes';
        else
          v_resolved := 'random';
        end if;

        v_steps := jsonb_build_array(jsonb_build_object(
          'rule', 'head_to_head',
          'results', v_h2h,
          'matchups', jsonb_build_array(v_matchup),
          'decisive', v_resolved = 'head_to_head'));

        if v_resolved <> 'head_to_head' then
          v_steps := v_steps || jsonb_build_array(jsonb_build_object(
            'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
        end if;
      else
        drop table if exists _wtb;
        create temp table _wtb on commit drop as
        select
          t.cid,
          t.name,
          t.five_stars,
          row_number() over (order by t.five_stars desc, t.cid) as rn
        from _wround t
        where t.cid = any(v_group);

        select five_stars into v_fn from _wtb where rn = v_need;
        select five_stars into v_fn1 from _wtb where rn = v_need + 1;

        v_resolved := case when v_fn > v_fn1 then 'five_star_votes' else 'random' end;

        v_steps := jsonb_build_array(jsonb_build_object(
          'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
      end if;

      select array_agg(cid order by rn) into v_pick from _wtb where rn <= v_need;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name) order by rn)
        into v_advanced from _wtb where rn <= v_need;

      v_tiebreaks := v_tiebreaks || jsonb_build_array(jsonb_build_object(
        'tied_at', v_score,
        'tied', v_tied,
        'slots', v_need,
        'steps', v_steps,
        'resolved_by', v_resolved,
        'advanced', v_advanced));

      v_finalists := v_finalists || v_pick;
      v_need := 0;
    end if;
  end loop;

  select coalesce(array_agg(cid order by total desc, cid), '{}'::uuid[]) into v_finalists
  from _wround where cid = any(v_finalists);

  if array_length(v_finalists, 1) is distinct from 2 then
    return jsonb_build_object(
      'finalists', to_jsonb(v_finalists),
      'tiebreaks', v_tiebreaks,
      'runoff', null,
      'winner_id', v_finalists[1]
    );
  end if;

  v_a := v_finalists[1];
  v_b := v_finalists[2];

  select
    round(coalesce(sum(weight) filter (where a_score > b_score), 0)
          * (select scale from _wscale where cid = v_a), 6),
    round(coalesce(sum(weight) filter (where b_score > a_score), 0)
          * (select scale from _wscale where cid = v_b), 6),
    round(coalesce(sum(weight) filter (where a_score = b_score), 0), 6)
  into v_prefers_a, v_prefers_b, v_ties
  from (
    select
      w.weight,
      coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_a), 0) as a_score,
      coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_b), 0) as b_score
    from _wweights w
  ) t;

  select total, five_stars into v_ta, v_fa from _wround where cid = v_a;
  select total, five_stars into v_tb, v_fb from _wround where cid = v_b;

  if v_prefers_a > v_prefers_b then
    v_winner := v_a; v_runoff_by := 'preference';
  elsif v_prefers_b > v_prefers_a then
    v_winner := v_b; v_runoff_by := 'preference';
  elsif v_ta > v_tb then
    v_winner := v_a; v_runoff_by := 'higher_score';
  elsif v_tb > v_ta then
    v_winner := v_b; v_runoff_by := 'higher_score';
  elsif v_fa > v_fb then
    v_winner := v_a; v_runoff_by := 'five_star_votes';
  elsif v_fb > v_fa then
    v_winner := v_b; v_runoff_by := 'five_star_votes';
  else
    v_winner := null; v_runoff_by := 'unresolved';
  end if;

  return jsonb_build_object(
    'finalists', to_jsonb(v_finalists),
    'tiebreaks', v_tiebreaks,
    'runoff', jsonb_build_object(
      'prefers_a', v_prefers_a,
      'prefers_b', v_prefers_b,
      'ties', v_ties,
      'five_stars_a', v_fa,
      'five_stars_b', v_fb,
      'resolved_by', v_runoff_by
    ),
    'winner_id', v_winner
  );
end;
$$;
