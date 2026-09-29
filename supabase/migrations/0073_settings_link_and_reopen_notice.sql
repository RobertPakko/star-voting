-- Two changes to what a poll writes to people.
--
-- * Every email now says where to stop them. The settings page has been able
--   to turn poll emails off since 0072, and nothing in an email said so: the
--   one moment somebody wants that switch is the moment they are reading a
--   letter they did not want, and the letter pointed only at the poll. The
--   footer of the letterhead now links to #/settings. A reader who is not
--   signed in is sent to sign in first and brought back there, the same
--   hand-off an invitation's link has always had; an invitee with no account
--   gets one by signing in, which is also the only way an address can say it
--   does not want to be written to.
--
-- * A poll put back to taking votes says so. Reopening used to be silent:
--   everybody in the poll had been told the results were ready, the results
--   then disappeared behind the gate again, and the only way to find out why
--   was to open the poll. Now the invitees hear it on both channels, like the
--   other three moments -- everybody but the creator, whose button it was.
--   It follows every rule the others do (poll_email_audience, wants_email,
--   wants_push) and adds none, and it is deliberately not a line on the
--   settings page: it is rare, and it is the same poll the reader already
--   asked to hear about.
--
--   An open poll tells nobody, and needs no special case to: it has no invite
--   list, and the watches filed through its link were let go when it closed.

-- ---------------------------------------------------------------------------
-- The letterhead, with a way out
-- ---------------------------------------------------------------------------

-- Verbatim but for the footer.
create or replace function public.poll_email_html(p_heading text, p_body_html text, p_link text)
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
                        Open poll &rarr;
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
                <p style="margin:0 0 8px; font-size:12px; line-height:1.6; color:#b3aec0; text-align:center;">
                  Don&rsquo;t want these emails?
                  <a href="https://choicelab.app/star-voting/#/settings" style="color:#9691a3; text-decoration:underline;">Change your notification settings</a>.
                </p>
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

comment on function public.poll_email_html(text, text, text) is 'The card every email this app sends is: a heading, a sentence, the button onto the poll, and a footer linking to the notification settings. Internal: the one place the letterhead is written down.';

-- ---------------------------------------------------------------------------
-- The fourth moment
-- ---------------------------------------------------------------------------

-- Verbatim but for the two reopen bodies.
create or replace function public.push_message(p_poll public.polls, p_event text)
returns jsonb
    language sql stable
    set search_path to 'public'
    as $$
  -- The poll's title is the notification's title. An email subject leaves it
  -- out because an inbox truncates a subject line to whatever fits; a
  -- notification has a line of its own for it and a body underneath, and the
  -- app's name is already drawn above both by the operating system.
  select jsonb_build_object(
    'title', coalesce(nullif(trim(p_poll.title), ''), 'A poll'),
    'body', case p_event
      when 'invite_options' then 'You''ve been invited to add options to this poll.'
      when 'invite_vote' then 'You''ve been invited to vote in this poll.'
      when 'opened' then 'The options are settled and voting is now open.'
      when 'results' then 'The results are ready.'
      when 'reopened_vote' then 'This poll has been reopened and is taking votes again.'
      when 'reopened_options' then 'This poll has been reopened and is collecting options again.'
    end,
    -- Relative to the app's own address, which the service worker resolves
    -- against its scope, so the same message opens the right page from a
    -- local build as well as from choicelab.app.
    'path', '#/polls/' || short_poll_id(p_poll.id),
    -- One notification per poll on the screen: a later one about the same
    -- poll replaces the earlier rather than stacking under it -- which is
    -- also what takes a stale "the results are ready" off a phone when the
    -- poll is reopened.
    'tag', short_poll_id(p_poll.id));
$$;

comment on function public.push_message(public.polls, text) is 'The notification sent about one of a poll''s moments -- invite_options, invite_vote, opened, results, reopened_vote, reopened_options. Internal.';

create function public.send_poll_reopened_email(p_poll public.polls, p_email text, p_collecting boolean)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_title_html text := '<strong>' || email_escape(coalesce(p_poll.title, 'a poll')) || '</strong>';
begin
  if p_collecting then
    perform send_poll_email(
      p_poll.id,
      p_email,
      'Your poll has been reopened',
      'The poll has reopened',
      v_title_html || ' has been reopened and is collecting options again.');
  else
    perform send_poll_email(
      p_poll.id,
      p_email,
      'Your poll has been reopened',
      'Voting has reopened',
      v_title_html || ' has been reopened and is taking votes again. The results will be '
        || 'shown when it closes.');
  end if;
end;
$$;

alter function public.send_poll_reopened_email(public.polls, text, boolean) owner to postgres;
revoke all on function public.send_poll_reopened_email(public.polls, text, boolean) from public;

comment on function public.send_poll_reopened_email(public.polls, text, boolean) is 'Posts one "this poll has been reopened" email to Resend. Best-effort: silent where pg_net, Vault or the API key is missing. Internal.';

create function public.notify_poll_reopened(p_poll_id uuid)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  v_collecting boolean;
  -- Only the creator can reopen a poll, so this is always them; read off the
  -- token like the other notifiers rather than assumed, so the one rule --
  -- nobody is told what they just did -- is stated the same way everywhere.
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    return;
  end if;

  -- One notice for the group, addressed about its first question, like every
  -- other: reopening is one act over all of them.
  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  -- A poll closed while it was still collecting reopens collecting, and the
  -- letter says which stage the reader is being asked back to.
  v_collecting := v_first.solicit_options and v_first.options_finalized_at is null;

  for v_email in select * from poll_email_audience(v_first, false, v_actor) loop
    perform send_poll_reopened_email(v_first, v_email, v_collecting);
  end loop;

  -- Watchers are asked for completeness and there are none: a poll's watches
  -- go when it closes, and open_poll_watch refuses a closed poll.
  perform push_poll(v_first,
    case when v_collecting then 'reopened_options' else 'reopened_vote' end,
    array(select * from poll_email_audience(v_first, false, v_actor)), true);
end;
$$;

alter function public.notify_poll_reopened(uuid) owner to postgres;
revoke all on function public.notify_poll_reopened(uuid) from public;

comment on function public.notify_poll_reopened(uuid) is 'Tells a poll''s invitees that it has been put back to taking votes (or options), by email and by push, once for the group, leaving out the creator who reopened it. Internal: called by reopen_poll.';

-- Verbatim but for the last statement.
create or replace function public.reopen_poll(p_poll_id uuid)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can reopen this poll';
  end if;

  if v_poll.closed_at is null then
    raise exception 'This poll is not closed';
  end if;

  -- Which questions actually showed a tally, asked *before* the close is
  -- lifted: poll_results_revealed is computed from closed_at and turnout, so a
  -- moment from now it answers no for all of them. A question closed with
  -- nothing in it revealed nothing and is not marked -- the votes it takes
  -- from here are its first ones, not late ones.
  update polls set reopened_after_reveal = true
  where id in (
    select q.id from poll_group_members(v_poll) q where poll_results_revealed(q.*)
  );

  -- One statement for the group, as close_poll is: the questions stopped at
  -- the same moment and they start again at the same moment. The triggers on
  -- closed_at do the rest -- settle_winner takes back a winner the poll no
  -- longer has, notify_results_ready drops the notice row so a second finish
  -- is announced like the first, and the whole group is broadcast to whoever
  -- has it open.
  --
  -- What this cannot do is take an invite poll back off full turnout: a
  -- question every invitee has answered is revealed whether or not it is
  -- closed, so reopening one leaves its results where they are. That is the
  -- same gate everything else in this schema reads, and the way to take more
  -- votes on such a poll has always been a new one.
  update polls set closed_at = null
  where id in (select q.id from poll_group_members(v_poll) q)
    and closed_at is not null;

  -- And the people in it are told, since they were told when it finished.
  perform notify_poll_reopened(p_poll_id);
end;
$$;

comment on function public.reopen_poll(uuid) is 'Puts a closed poll back to taking votes, keeping every ballot in it, for every question at once, and tells its invitees so. Marks the questions whose results were out, so that a vote cast or changed from here says so on the results.';
