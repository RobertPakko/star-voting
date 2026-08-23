-- Tell the people in a poll when its results are ready.
--
-- An invitation was the only thing this app ever emailed, which meant the app
-- announced the one moment nobody was waiting for and stayed silent through
-- the one everybody was. A poll's results unlock on their own -- when the last
-- invitee votes, or when the creator closes it -- and until now the only way
-- to find out was to keep opening the poll. The people most likely to miss it
-- are the ones who voted early, which is to say the ones who cared enough to
-- answer first.
--
-- The shape is the invite email's, deliberately: `pg_net` posting to Resend
-- with a key read from Vault at send time, best-effort, never blocking or
-- failing the thing that triggered it. What is new is that this is a
-- *transition* rather than an insert, and a transition has to be noticed
-- exactly once.
--
-- Four decisions worth the words:
--
--   * **Once per poll, not once per question.** A group's questions unlock
--     together (`poll_results_revealed` asks the gate of every one of them),
--     so five questions are one result and one email, pointing at question 1
--     -- the same rule, and the same landing place, as the invitation.
--
--   * **The claim is a row, not a column.** `results_notices` holds one row
--     per poll that has been announced, and its primary key is the whole of
--     the once-only rule: two ballots landing in the same instant both try to
--     insert it, one wins, one email goes. A column on `polls` would have done
--     the same job and would also have widened every `select *` the app makes
--     and woken every watcher of the poll a second time, for bookkeeping
--     nothing on screen reads.
--
--   * **A reset takes the notice back.** Reset deletes every vote and reopens
--     the poll, which can then finish again with a different answer; that is a
--     second result, and the people in the poll are told about it. So anything
--     that puts a poll back to taking votes drops its notice row, and the
--     announcement is a property of the poll being finished rather than of it
--     having once been finished.
--
--   * **One request per address.** Resend would take the whole list in one
--     `to`, and that would show every invitee every other invitee's address --
--     which is precisely what a poll with respondents hidden promises not to
--     do. The fan-out is the price of the promise.
--
--   * **The creator is told only when the poll finished on its own.** Closing
--     is theirs to do, so a poll with a `closed_at` on it ended by their own
--     hand and the email would be news they just made. See
--     `poll_results_audience` below.
--
-- The email says the results are ready and links to them; it does not name
-- the winner. A poll of several questions has one winner per question and no
-- single one to name, an email cannot be un-read by somebody who wanted to
-- see the tally first, and the link is one tap from the answer either way.


-- Which polls have already had their results announced. One row per poll --
-- the group's first question, which is the row the invitation names too --
-- inserted by the claim below and deleted when the poll goes back to taking
-- votes.
--
-- Nothing reads this but the function below it. No grants, and RLS on with no
-- policies: `anon` and `authenticated` cannot see it at all, and the
-- SECURITY DEFINER functions that maintain it are owned by `postgres` and so
-- are not subject to it.
CREATE TABLE IF NOT EXISTS "public"."results_notices" (
  "poll_id" "uuid" PRIMARY KEY REFERENCES "public"."polls"("id") ON DELETE CASCADE,
  "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."results_notices" OWNER TO "postgres";

ALTER TABLE "public"."results_notices" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE "public"."results_notices" IS 'One row per poll whose results have been announced by email, keyed on the group''s first question. Internal bookkeeping: no grants, and dropped when a reset puts the poll back to taking votes.';


-- Whether the poll as a whole has a result to announce.
--
-- Not the same question as `poll_results_revealed`, and the difference is the
-- one that matters to an email. That function answers about one question:
-- *this* question has taken a ballot, and every question in its group has
-- stopped taking votes. A poll closed before anybody reached question 5 has
-- results for question 1 and none for question 5, which is right on the page
-- and would be wrong in an inbox -- there is one result to be told about, and
-- it is the poll's.
--
-- So the ballot test is asked of the group rather than of the row: at least
-- one ballot somewhere in the poll, and every question's gate open. On a poll
-- that asks one question the two are the same sentence.
CREATE OR REPLACE FUNCTION "public"."poll_results_ready"("p_poll" "public"."polls") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
           select 1 from ballots b
           join poll_group_members(p_poll) q on q.id = b.poll_id
         )
     and (select bool_and(poll_gate_open(q.*)) from poll_group_members(p_poll) q);
$$;


ALTER FUNCTION "public"."poll_results_ready"("p_poll" "public"."polls") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_results_ready"("p_poll" "public"."polls") IS 'Whether this poll, as a whole, has a result: a ballot somewhere in the group, and every question in it stopped. The email''s question, where poll_results_revealed is the page''s. Internal.';


-- Everyone the app has an address for and a reason to tell.
--
-- **Every invitee**, and not just the ones who voted. An invitee who did not
-- vote is still in the poll -- it finished around them, and the result is a
-- decision they are subject to. An open poll has no invitees at all, because
-- its voters were never asked for an address.
--
-- **The creator, only if the poll finished on its own.** A poll ends one of
-- two ways: the last invitee votes, or somebody closes it -- and only the
-- creator can close it. Telling them the news they just made themselves is an
-- email whose entire content they already have, so `closed_at` is the test:
-- set means closed by hand, and the creator is dropped from the list. It
-- drops them as an invitee too, on a poll they invited themselves to; the
-- reason they need no email is that they closed the poll, and it does not stop
-- being the reason because they are also on the invite list.
--
-- An open poll only ever ends by being closed, so its audience is empty and
-- nothing is sent. That is the rule landing where it points rather than a case
-- missed: an open poll's voters gave no addresses, and the one person it could
-- have written to is the person who closed it.
--
-- Lowercased and unioned, so a creator who invited themselves is one person
-- with one email. Addresses come out of `invited_voters`, which
-- `normalize_invited_email` has already lowercased; the creator's comes off
-- the poll, where `set_poll_creator_email` did the same.
CREATE OR REPLACE FUNCTION "public"."poll_results_audience"("p_poll" "public"."polls") RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with told as (
    select lower(p_poll.created_by_email) as email
    where p_poll.created_by_email is not null
    union
    select lower(iv.email)
    from invited_voters iv
    where iv.poll_id = p_poll.id
  )
  select email
  from told
  where p_poll.closed_at is null
     or email is distinct from lower(p_poll.created_by_email);
$$;


ALTER FUNCTION "public"."poll_results_audience"("p_poll" "public"."polls") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_results_audience"("p_poll" "public"."polls") IS 'Every address to tell that this poll has finished: every invitee, plus the creator only where the poll unlocked on its own rather than being closed by hand. Internal.';


-- The email itself, for one address.
--
-- Split out from the bookkeeping above it so that the thing which decides
-- *whether* to announce and the thing which knows what an announcement looks
-- like are not the same function. Silent where the invite email is silent:
-- no `pg_net`, no Vault, or no key in it, and nothing is sent -- which is the
-- throwaway database `npm test` builds, and a Supabase project whose key has
-- not been pasted in yet. See AGENTS.md, "Invite emails".
CREATE OR REPLACE FUNCTION "public"."send_results_ready_email"("p_poll" "public"."polls", "p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_api_key text;
  v_title_html text;
  v_link text;
  v_html text;
begin
  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return;
  end if;

  select decrypted_secret into v_api_key
  from vault.decrypted_secrets
  where name = 'resend_api_key'
  limit 1;

  if v_api_key is null then
    return;
  end if;

  v_title_html := replace(replace(replace(coalesce(p_poll.title, 'a poll'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  v_link := 'https://choicelab.app/star-voting/#/polls/' || p_poll.id::text;

  v_html := $html$<!doctype html>
<html>
  <body style="margin:0; padding:0; background-color:#f2eefc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2eefc; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(126,20,255,0.12);">
            <tr>
              <td align="center" style="background-color:#ffffff; padding:40px 24px 24px; border-bottom:1px solid #f0edf7;">
                <img src="https://choicelab.app/star-voting/logo.png" width="72" height="72" alt="STAR Voting"
                     style="display:block; width:72px; height:72px; border-radius:16px;">
                <div style="margin-top:16px; font-size:20px; font-weight:700; color:#1a1523; letter-spacing:0.2px;">
                  STAR Voting
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 28px;">
                <h1 style="margin:0 0 12px; font-size:22px; line-height:1.3; color:#1a1523; font-weight:700;">
                  The results are in
                </h1>
                <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#5b5468;">
                  Voting has finished in&nbsp;<strong>$html$ || v_title_html || $html$</strong>, so the
                  scores, the runoff and the full ranking are now yours to read.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td align="center" style="border-radius:10px; background:linear-gradient(135deg,#7e14ff,#47bfff); background-color:#7e14ff;">
                      <a href="$html$ || v_link || $html$"
                         style="display:inline-block; padding:14px 36px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:10px;">
                        See the results &rarr;
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:28px 0 0; font-size:13px; line-height:1.6; color:#9691a3;">
                  Button not working? Paste this link into your browser:<br>
                  <a href="$html$ || v_link || $html$" style="color:#7e14ff; word-break:break-all;">$html$ || v_link || $html$</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px; border-top:1px solid #f0edf7;">
                <p style="margin:0; font-size:12px; line-height:1.6; color:#b3aec0; text-align:center;">
                  Sent by ChoiceLab.app
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
$html$;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_api_key
    ),
    body := jsonb_build_object(
      'from', 'STAR Voting <noreply@choicelab.app>',
      'to', jsonb_build_array(p_email),
      'subject', 'Results are in: ' || coalesce(p_poll.title, 'a poll'),
      'html', v_html
    ),
    timeout_milliseconds := 8000
  );
end;
$_$;


ALTER FUNCTION "public"."send_results_ready_email"("p_poll" "public"."polls", "p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."send_results_ready_email"("p_poll" "public"."polls", "p_email" "text") IS 'Posts one "the results are in" email to Resend. Best-effort: silent where pg_net, Vault or the API key is missing. Internal.';


-- The whole rule, in one place, asked after anything that could have moved a
-- poll across the line in either direction.
--
-- Idempotent by construction, which is what lets it be called from four
-- triggers without any of them having to know what the others have already
-- done: it re-derives whether the poll has a result and reconciles the notice
-- row with that answer. Calling it on a poll nothing has changed about does
-- nothing at all.
--
-- The claim comes before the send, so a mailer that is not configured leaves
-- a notice row with no email behind it. That is the same bargain the
-- invitation makes -- a poll created before the key was pasted in sends no
-- invitations either -- and the alternative, releasing the claim on a failed
-- send, would turn every transient Resend outage into a duplicate on the next
-- vote.
CREATE OR REPLACE FUNCTION "public"."notify_results_ready"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
begin
  select * into v_poll from polls where id = p_poll_id;

  -- A poll on its way out -- the nightly purge, or the creator's own Delete
  -- button -- has nobody left to tell, and its notice row is cascading after
  -- it either way.
  if not found then
    return;
  end if;

  -- poll_group_members orders by question_position with nulls first, so this
  -- is question 1 of a group and the poll itself when it has no group. It is
  -- the row the invitation names, so the two emails about one poll point at
  -- the same page.
  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  if not poll_results_ready(v_first) then
    -- Back to taking votes. A poll that finishes again is a second result,
    -- and the people in it are told about it again.
    delete from results_notices where poll_id = v_first.id;
    return;
  end if;

  -- The once-only rule, and all of it: two ballots arriving together both run
  -- this, and the primary key decides which of them is the announcement.
  insert into results_notices (poll_id) values (v_first.id)
  on conflict (poll_id) do nothing;

  if not found then
    return;
  end if;

  -- One request per address rather than one request with every address in it;
  -- see the note at the top of this file.
  for v_email in select * from poll_results_audience(v_first) loop
    perform send_results_ready_email(v_first, v_email);
  end loop;
end;
$$;


ALTER FUNCTION "public"."notify_results_ready"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notify_results_ready"("p_poll_id" "uuid") IS 'Reconciles a poll''s results-ready announcement with whether it actually has a result: sends once when it crosses the line, and forgets when a reset takes it back. Internal: called from the triggers below, never by a client.';


-- The four things that can move a poll across the line, and the shape of each
-- is the broadcast trigger already sitting beside it.
--
--   * a ballot arriving -- the last invitee votes and the results unlock;
--   * a ballot leaving -- reset, which puts the poll back to taking votes;
--   * an invitee leaving -- the denominator drops to what has already voted,
--     which unlocks the results without anybody having voted at all;
--   * `closed_at` moving -- the creator closing the poll, or reset reopening
--     it.
--
-- Nothing is needed for an invitee *arriving*: guard_invitee_changes already
-- refuses to widen the list of a poll whose results are out, so an insert
-- cannot cross this line in either direction.
CREATE OR REPLACE FUNCTION "public"."notify_results_for_touched"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
begin
  for v_poll in select distinct poll_id from new_rows loop
    perform notify_results_ready(v_poll);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_results_for_touched"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_results_for_emptied"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
begin
  for v_poll in select distinct poll_id from old_rows loop
    perform notify_results_ready(v_poll);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_results_for_emptied"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_results_for_poll"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform notify_results_ready(NEW.id);
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_results_for_poll"() OWNER TO "postgres";


CREATE OR REPLACE TRIGGER "ballots_notify_results_insert"
  AFTER INSERT ON "public"."ballots"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."notify_results_for_touched"();


CREATE OR REPLACE TRIGGER "ballots_notify_results_delete"
  AFTER DELETE ON "public"."ballots"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."notify_results_for_emptied"();


CREATE OR REPLACE TRIGGER "invited_voters_notify_results_delete"
  AFTER DELETE ON "public"."invited_voters"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."notify_results_for_emptied"();


-- Column-scoped and guarded, so the notice row this trigger's own function
-- writes cannot bring it round again: setting a notice touches
-- results_notices rather than polls, and nothing but closed_at gets this far
-- in any case.
CREATE OR REPLACE TRIGGER "polls_notify_results_closed"
  AFTER UPDATE OF "closed_at" ON "public"."polls"
  FOR EACH ROW
  WHEN ("new"."closed_at" IS DISTINCT FROM "old"."closed_at")
  EXECUTE FUNCTION "public"."notify_results_for_poll"();


REVOKE ALL ON FUNCTION "public"."poll_results_ready"("p_poll" "public"."polls") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."poll_results_audience"("p_poll" "public"."polls") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."send_results_ready_email"("p_poll" "public"."polls", "p_email" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."notify_results_ready"("p_poll_id" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."notify_results_for_touched"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."notify_results_for_emptied"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."notify_results_for_poll"() FROM PUBLIC;
