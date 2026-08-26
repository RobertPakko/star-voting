-- What a poll writes to people, and which of them it writes to.
--
-- Two emails became four, and the reason is that the app had been treating
-- "you are on this list" as the only thing worth an inbox. A poll that
-- collects its options first has three moments in it, not one -- come and add
-- your options, voting has started, here is the answer -- and an invitation
-- worded for the middle one arrived at the beginning and then nothing arrived
-- at all. So the invitation now says whichever of the two things is true when
-- it is sent, and opening the poll writes its own.
--
-- **Nobody is told what they just did.** The creator sets the poll up, so an
-- invitation telling them they have been invited is an email whose entire
-- content they already have -- and being on their own invite list, which the
-- create form offers with a checkbox, does not make it news. That rule was
-- already written down for the results (`poll_results_audience`), and it is
-- the same rule here: the creator hears about a transition only when
-- something other than their own hand made it. Closing a poll by hand and
-- opening it by hand are their own news; a poll that opens itself because the
-- last person confirmed, or finishes because the last person voted, is not.
--
-- **One letterhead, in one place.** Every email is the same card with a
-- heading, a sentence, a button and a link under it, and it was written out
-- twice already. Four copies of a table layout is four places for a padding
-- value to drift, so the shell is `poll_email_html` and the posting to Resend
-- is `send_poll_email`; what each email knows about itself is four strings.
--
-- **Subjects say what the letter is about, not how exciting it is, and they
-- do not carry the poll's title.** "You're invited to vote" is how bulk mail
-- opens, and Gmail reads it that way. Putting the title in the subject fixed
-- that and broke something else: a title is as long as its author made it,
-- and an inbox truncates -- so the one part of a subject that is always
-- readable would have been spent on a title that might not be. The four
-- subjects are short, plain and fixed, and the poll is named in the first
-- line of the body, where there is room for it and where it is next to what
-- to do about it.
--
-- Nothing here changes the bargain the senders make: `pg_net` and Vault may
-- not be there, the key may not be set, and every one of these functions
-- returns quietly when they are not. An email is never allowed to fail the
-- thing that triggered it.


-- ---------------------------------------------------------------------------
-- One letterhead, one sender
-- ---------------------------------------------------------------------------

-- Anything a poll's author typed is dropped into HTML, so it is escaped
-- first: a title with an ampersand in it is a title, not markup.
create or replace function public.email_escape(p_text text)
returns text
language sql immutable
as $$
  select replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

alter function public.email_escape(text) owner to postgres;

comment on function public.email_escape(text) is
  'Text as it goes into an email body: the three characters that would otherwise be markup. Internal.';


-- The card every email is. The parts that differ are the heading, the
-- sentence under it, what the button says and where it goes; everything else
-- is the same in all four and belongs in exactly one place.
create or replace function public.poll_email_html(
  p_heading text,
  p_body_html text,
  p_cta text,
  p_link text
)
returns text
language sql immutable
as $_$
  select $html$<!doctype html>
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
                  $html$ || p_heading || $html$
                </h1>
                <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#5b5468;">
                  $html$ || p_body_html || $html$
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td align="center" style="border-radius:10px; background:linear-gradient(135deg,#7e14ff,#47bfff); background-color:#7e14ff;">
                      <a href="$html$ || p_link || $html$"
                         style="display:inline-block; padding:14px 36px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:10px;">
                        $html$ || p_cta || $html$
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:28px 0 0; font-size:13px; line-height:1.6; color:#9691a3;">
                  Button not working? Paste this link into your browser:<br>
                  <a href="$html$ || p_link || $html$" style="color:#7e14ff; word-break:break-all;">$html$ || p_link || $html$</a>
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
$html$
$_$;

alter function public.poll_email_html(text, text, text, text) owner to postgres;
revoke all on function public.poll_email_html(text, text, text, text) from public;

comment on function public.poll_email_html(text, text, text, text) is
  'The card every email this app sends is: a heading, a sentence, a button and the link under it. Internal: the one place the letterhead is written down.';


-- The posting itself, and the whole of the best-effort bargain: no pg_net, no
-- Vault, no key, no email -- and never an error out of any of those, because
-- this runs inside somebody's vote, confirmation or button press and none of
-- them is a request to send mail.
create or replace function public.send_poll_email(
  p_poll_id uuid,
  p_to text,
  p_subject text,
  p_heading text,
  p_body_html text,
  p_cta text
)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_api_key text;
  v_link text;
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

  v_link := 'https://choicelab.app/star-voting/#/polls/' || p_poll_id::text;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_api_key
    ),
    body := jsonb_build_object(
      'from', 'STAR Voting <noreply@choicelab.app>',
      'to', jsonb_build_array(p_to),
      'subject', p_subject,
      'html', poll_email_html(p_heading, p_body_html, p_cta, v_link)
    ),
    timeout_milliseconds := 8000
  );
end;
$$;

alter function public.send_poll_email(uuid, text, text, text, text, text) owner to postgres;
revoke all on function public.send_poll_email(uuid, text, text, text, text, text) from public;

comment on function public.send_poll_email(uuid, text, text, text, text, text) is
  'Posts one email about one poll to Resend, linking to that poll. Best-effort: silent where pg_net, Vault or the API key is missing. Internal: the one place this app talks to a mailer.';


-- ---------------------------------------------------------------------------
-- Who hears about a transition
-- ---------------------------------------------------------------------------

-- Everybody in the poll, and the creator only where the transition was not
-- their own doing. Deduplicated and lowercased, and every invitee whether or
-- not they have voted: a poll that moved on without them still moved on
-- around them.
--
-- The creator is dropped from the invite list too, not just from the end of
-- it -- a creator who invited themselves is one person with one inbox, and
-- the reason they need no email does not stop applying because they ticked a
-- box on the create form.
create or replace function public.poll_email_audience(p_poll public.polls, p_include_creator boolean)
returns setof text
language sql stable security definer set search_path to 'public'
as $$
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
  where p_include_creator
     or email is distinct from lower(p_poll.created_by_email);
$$;

alter function public.poll_email_audience(public.polls, boolean) owner to postgres;
revoke all on function public.poll_email_audience(public.polls, boolean) from public;

comment on function public.poll_email_audience(public.polls, boolean) is
  'Every address to tell about something that happened to this poll: every invitee, plus the creator only where the thing was not their own doing. Internal.';


-- The results audience, unchanged in what it answers and now saying it in
-- terms of the rule above: closed_at set means somebody closed the poll by
-- hand, and only the creator can, so the creator already knows.
create or replace function public.poll_results_audience(p_poll public.polls)
returns setof text
language sql stable security definer set search_path to 'public'
as $$
  select * from poll_email_audience(p_poll, p_poll.closed_at is null);
$$;

alter function public.poll_results_audience(public.polls) owner to postgres;
revoke all on function public.poll_results_audience(public.polls) from public;

comment on function public.poll_results_audience(public.polls) is
  'Every address to tell that this poll has finished: every invitee, plus the creator only where the poll unlocked on its own rather than being closed by hand. Internal.';


-- ---------------------------------------------------------------------------
-- The invitation, in its two readings
-- ---------------------------------------------------------------------------

-- Which invitation this address is owed, if any. A predicate rather than a
-- branch inside the trigger, because who gets written to is the part worth
-- testing and the sending itself cannot be tested at all -- see
-- test/sql/cases/23_who_the_emails_go_to.sql.
create or replace function public.poll_invite_kind(p_poll public.polls, p_email text)
returns text
language sql stable security definer set search_path to 'public'
as $$
  select case
    -- Defensive: guard_invitee_changes already refuses a list on a poll that
    -- is open to anyone with the link.
    when p_poll.mode is distinct from 'invite' then 'none'
    -- The creator set the poll up. Nothing about that is news to them.
    when lower(p_email) is not distinct from lower(p_poll.created_by_email) then 'none'
    -- Still collecting: what this person is being asked for is options, and
    -- there is nothing to vote on yet.
    when p_poll.solicit_options and p_poll.options_finalized_at is null then 'options'
    else 'vote'
  end;
$$;

alter function public.poll_invite_kind(public.polls, text) owner to postgres;
revoke all on function public.poll_invite_kind(public.polls, text) from public;

comment on function public.poll_invite_kind(public.polls, text) is
  'Which invitation an address on this poll''s list is owed: "options" while the poll is still collecting them, "vote" once there is a ballot, and "none" for the creator, who set the poll up. Internal.';


create or replace function public.send_invite_email()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_kind text;
  v_title_html text;
begin
  select * into v_poll from polls where id = new.poll_id;

  if not found then
    return new;
  end if;

  v_kind := poll_invite_kind(v_poll, new.email);

  if v_kind = 'none' then
    return new;
  end if;

  v_title_html := '<strong>' || email_escape(coalesce(v_poll.title, 'a poll')) || '</strong>';

  if v_kind = 'options' then
    perform send_poll_email(
      new.poll_id,
      new.email,
      'You''ve been added to a new poll',
      'Choose the options',
      'Choose options for ' || v_title_html || '. Sign in with this email address to add '
        || 'yours, and to say when you have finished.',
      'Add options &rarr;');
  else
    perform send_poll_email(
      new.poll_id,
      new.email,
      'You''ve been added to a new poll',
      'Your ballot is ready',
      'Vote now for ' || v_title_html || '. Sign in with this email address to see the '
        || 'options and cast your ballot.',
      'Open poll &rarr;');
  end if;

  return new;
end;
$$;

alter function public.send_invite_email() owner to postgres;
revoke all on function public.send_invite_email() from public;

comment on function public.send_invite_email() is
  'Writes to somebody added to a poll''s invite list, about whichever stage the poll is at; nothing at all to the creator. Best-effort, like every email here.';


-- ---------------------------------------------------------------------------
-- The poll opening
-- ---------------------------------------------------------------------------

-- A poll that collected its options spends its first stretch with nothing to
-- vote on, and the moment that changes is the moment its voters are waiting
-- for. It used to pass in silence: the invitation had been sent at creation,
-- and the next email was the result.
create or replace function public.send_poll_opened_email(p_poll public.polls, p_email text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  perform send_poll_email(
    p_poll.id,
    p_email,
    'Voting is now open for your poll',
    'Voting is now open',
    'Options have been finalized and voting is now open for <strong>'
      || email_escape(coalesce(p_poll.title, 'a poll')) || '</strong>.',
    'Cast your ballot &rarr;');
end;
$$;

alter function public.send_poll_opened_email(public.polls, text) owner to postgres;
revoke all on function public.send_poll_opened_email(public.polls, text) from public;

comment on function public.send_poll_opened_email(public.polls, text) is
  'Posts one "voting is open" email to Resend. Best-effort: silent where pg_net, Vault or the API key is missing. Internal.';


-- Told once per poll rather than once per question, pointing at question 1 --
-- the group opens in one act, and it is the row every other email about this
-- poll names.
--
-- p_by_itself is the whole of who hears it: the creator's own Open poll
-- button is not news to the creator, and the poll opening because the last
-- invitee confirmed is. There is no notice row behind this one, unlike the
-- results: opening happens exactly once in a poll's life -- nothing puts
-- options_finalized_at back to null, reset included -- so the two callers
-- below are the two openings there are.
create or replace function public.notify_poll_opened(p_poll_id uuid, p_by_itself boolean)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    return;
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  -- One request per address rather than one request with every address in
  -- it: Resend would show every invitee every other invitee's address, which
  -- is what a poll with its respondents hidden promises not to do.
  for v_email in select * from poll_email_audience(v_first, p_by_itself) loop
    perform send_poll_opened_email(v_first, v_email);
  end loop;
end;
$$;

alter function public.notify_poll_opened(uuid, boolean) owner to postgres;
revoke all on function public.notify_poll_opened(uuid, boolean) from public;

comment on function public.notify_poll_opened(uuid, boolean) is
  'Tells a poll''s voters that it has stopped collecting options and started taking votes, once for the group. Internal: called by the two things that open a poll, which say between them whether the creator is hearing news.';


-- The creator's own button. They are the one person who does not need to be
-- told, so p_by_itself is false.
create or replace function public.finalize_options(p_poll_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_short record;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can finalize these options';
  end if;

  if not v_poll.solicit_options then
    raise exception 'The options for this poll were set when it was created';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  -- Asked of this question, which is enough: the group is opened in one
  -- statement below, so its questions are finalized together or not at all
  -- and can never disagree about whether they have been.
  if v_poll.options_finalized_at is not null then
    raise exception 'The options for this poll have already been finalized';
  end if;

  -- The same floor create_poll puts on a poll whose creator wrote the
  -- options: one option is not an election. Every question is checked
  -- *before* any is opened -- a poll half-opened would be taking votes on
  -- some questions while others were still gathering, which is the state
  -- opening the poll in one act exists to prevent.
  select q.question_title, count(c.id)::int as options
  into v_short
  from poll_group_members(v_poll) q
  left join candidates c on c.poll_id = q.id
  group by q.id, q.question_position, q.question_title
  having count(c.id) < 2
  order by min(q.question_position)
  limit 1;

  if found then
    -- Named, because on a poll of several questions "add two options" leaves
    -- the creator to find which of five is short. A poll asking one question
    -- has no name to give and says what it always said.
    if v_short.question_title is null then
      raise exception 'Add at least two options before opening the poll for voting';
    end if;
    raise exception 'Add at least two options to "%" before opening the poll for voting',
      v_short.question_title;
  end if;

  update polls set options_finalized_at = now()
  where id in (select q.id from poll_group_members(v_poll) q);

  perform notify_poll_opened(v_poll.id, false);
end;
$$;

alter function public.finalize_options(uuid) owner to postgres;
revoke all on function public.finalize_options(uuid) from public;
grant all on function public.finalize_options(uuid) to authenticated;

comment on function public.finalize_options(uuid) is
  'Turns a collected option list into a ballot, for every question of the poll at once, and tells the voters. Refuses until each of them has two options, naming the one that is short.';


-- The poll opening by itself, which is news to everybody in it, the creator
-- included: they set the deadline in motion and somebody else's confirmation
-- is what tripped it.
--
-- The email goes only where the update actually opened something. This runs
-- inside every confirmation and every invitee removal on a soliciting poll,
-- so most of the time it opens nothing at all, and a second call after the
-- poll is already open must not write to anybody twice.
create or replace function public.open_options_when_all_confirmed(p_poll_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  -- Gone, or on its way out behind a cascade.
  if not found then
    return;
  end if;

  if not options_confirmed_by_everyone(v_poll) then
    return;
  end if;

  -- The floor finalize_options applies, applied here as a reason to wait
  -- rather than as an error: one option is not an election, and a poll that
  -- everybody has finished adding to and that still has nothing to vote on is
  -- a poll for its creator to look at.
  if exists (
    select 1
    from poll_group_members(v_poll) q
    left join candidates c on c.poll_id = q.id
    group by q.id
    having count(c.id) < 2
  ) then
    return;
  end if;

  update polls set options_finalized_at = now()
  where id in (select q.id from poll_group_members(v_poll) q)
    and options_finalized_at is null;

  if found then
    perform notify_poll_opened(v_poll.id, true);
  end if;
end;
$$;

alter function public.open_options_when_all_confirmed(uuid) owner to postgres;
revoke all on function public.open_options_when_all_confirmed(uuid) from public;

comment on function public.open_options_when_all_confirmed(uuid) is
  'Opens a soliciting poll for voting once every invitee has confirmed every question in it, telling everybody including the creator, and does nothing at all otherwise. Internal: called after a confirmation and after an invitee is removed, so it must never raise.';


-- ---------------------------------------------------------------------------
-- The results
-- ---------------------------------------------------------------------------

-- Shorter by two clauses. What the reader needs from this email is that there
-- is something to read and where; the scores, the runoff and the ranking are
-- one tap away and describing them in the body only delayed the tap.
create or replace function public.send_results_ready_email(p_poll public.polls, p_email text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  perform send_poll_email(
    p_poll.id,
    p_email,
    'Results are available for your poll',
    'The results are in',
    'Results are available for <strong>'
      || email_escape(coalesce(p_poll.title, 'a poll')) || '</strong>.',
    'See the results &rarr;');
end;
$$;

alter function public.send_results_ready_email(public.polls, text) owner to postgres;
revoke all on function public.send_results_ready_email(public.polls, text) from public;

comment on function public.send_results_ready_email(public.polls, text) is
  'Posts one "the results are in" email to Resend. Best-effort: silent where pg_net, Vault or the API key is missing. Internal.';
