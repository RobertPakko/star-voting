-- Two changes to who a poll writes to, and how they can stop it.
--
-- * Every email now says where to stop them. The settings page has been able
--   to turn poll emails off since 0072, and nothing in an email said so: the
--   one moment somebody wants that switch is the moment they are reading a
--   letter they did not want, and the letter pointed only at the poll. The
--   footer of the letterhead now links to #/settings. A reader who is not
--   signed in is sent to sign in first and brought back there, the same
--   hand-off an invitation's link has always had.
--
-- * An account that answers an open poll follows it. Until now an open poll
--   told its voters about opening and finishing only through a watch -- one
--   browser, one press of Notify me, no account attached -- because an open
--   poll has no invite list and so no audience. That is the right shape for a
--   voter who never signs in, and the wrong one for somebody who has: their
--   account already has a say over which channels it hears on, on every
--   device it is bound to, and an open poll they voted in was the one kind of
--   poll that setting could not reach. So a signed-in voter's browser files a
--   follow (open_poll_follow) when they vote or confirm the options, and a
--   follower is simply part of the poll's audience: poll_email_audience
--   includes them, so they are emailed and pushed exactly as an invitee is,
--   by the same functions, under the same two settings, minus whoever acted.
--
--   What this records is that an account is in an open poll -- not which
--   ballot is theirs. A follow carries no voter key and no timestamp, and it
--   is filed by the browser in a request of its own rather than inside the
--   ballot's transaction, so it shares nothing with the ballot row a join
--   could be made on. It is no more than a watch from a browser bound to the
--   same account already disclosed, through push_subscriptions.endpoint. Like
--   a watch it is one-shot: filed against the group's first question, and
--   deleted once the results are announced or the poll closes with nothing to
--   announce, so no account carries a list of every open poll it ever
--   answered.


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
-- Following an open poll
-- ---------------------------------------------------------------------------

create table public.poll_follows (
  poll_id uuid not null references public.polls (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (poll_id, user_id)
);

alter table public.poll_follows owner to postgres;
alter table public.poll_follows enable row level security;
revoke all on table public.poll_follows from anon, authenticated;

comment on table public.poll_follows is 'An account that has answered an open poll, and so hears about it opening and finishing as an invitee would. No voter key, no timestamp; filed against the group''s first question and deleted once the results are announced. Written through open_poll_follow; read by nobody but the functions that send.';

create function public.open_poll_follow(p_poll_id uuid)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_user uuid := auth.uid();
  v_poll polls;
  v_first polls;
begin
  -- Filed by the browser on the reader's behalf, never pressed for, so every
  -- reason not to is a quiet return rather than an error to show somebody who
  -- asked for nothing: nobody signed in, a poll that is not open, its own
  -- creator (who opens and closes it, and so is never told), and a poll that
  -- has already said whatever it was going to say.
  if v_user is null then
    return;
  end if;

  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found or v_poll.created_by = v_user then
    return;
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  if v_first.closed_at is not null then
    return;
  end if;

  insert into poll_follows (poll_id, user_id)
  values (v_first.id, v_user)
  on conflict do nothing;
end;
$$;

alter function public.open_poll_follow(uuid) owner to postgres;
revoke all on function public.open_poll_follow(uuid) from public;
grant all on function public.open_poll_follow(uuid) to authenticated;

comment on function public.open_poll_follow(uuid) is 'Has the signed-in account hear about this open poll -- voting opening, the results being ready -- as an invitee would, on whichever channels its settings allow. Filed by the browser when the account votes or confirms the options; quietly does nothing where there is nothing to follow.';

-- Verbatim but for the followers.
create or replace function public.poll_email_audience(p_poll public.polls, p_include_creator boolean, p_actor text)
returns setof text
    language sql stable security definer
    set search_path to 'public'
    as $$
  with told as (
    select lower(p_poll.created_by_email) as email
    where p_poll.created_by_email is not null
    union
    select lower(iv.email)
    from invited_voters iv
    where iv.poll_id = p_poll.id
    union
    -- An open poll's signed-in voters, who are in it as surely as an invitee
    -- is in an invite poll. Filed against the first question, which is the
    -- row every notice about a poll is addressed about.
    select lower(u.email)
    from poll_follows f
    join auth.users u on u.id = f.user_id
    where f.poll_id = p_poll.id
      and u.email is not null
  )
  select email
  from told
  where (p_include_creator
          or email is distinct from lower(p_poll.created_by_email))
    -- Null is nobody, and nobody is dropped: an open poll's voter signs
    -- nothing and the purge runs as no one.
    and email is distinct from lower(p_actor);
$$;

comment on function public.poll_email_audience(public.polls, boolean, text) is 'Every address to tell about something that happened to this poll: every invitee and every account following it, minus the creator where the thing was their own doing, and minus the address whose own act caused it. Internal.';

-- Verbatim from 0072 but for letting the follows go with the watches.
create or replace function public.notify_results_ready(p_poll_id uuid)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  -- The last ballot, the removal that left nobody to wait for, or the Close
  -- button: whichever of them crossed the line, it is this transaction and
  -- this is who is in it.
  v_actor text := lower(auth.jwt() ->> 'email');
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

    -- A poll closed with nobody having voted is finished with nothing to
    -- announce, so its watches and follows will never be answered. Gone now
    -- rather than left on the poll until the purge.
    if v_first.closed_at is not null then
      delete from poll_push_watches where poll_id = v_first.id;
      delete from poll_follows where poll_id = v_first.id;
    end if;
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
  -- see the note at the top of 0072.
  for v_email in select * from poll_results_audience(v_first, v_actor) loop
    perform send_results_ready_email(v_first, v_email);
  end loop;

  perform push_poll(v_first, 'results',
    array(select * from poll_results_audience(v_first, v_actor)), true);

  -- A watch has done its job once the results are out, and so has a follow.
  -- Keeping either would leave a record on the poll, for the rest of its six
  -- months, of a browser or an account that answered it.
  delete from poll_push_watches where poll_id = v_first.id;
  delete from poll_follows where poll_id = v_first.id;
end;
$$;

comment on function public.notify_results_ready(uuid) is 'Reconciles a poll''s results-ready announcement with whether it actually has a result: sends once when it crosses the line, by email and by push, to everybody but whoever crossed it, and forgets when a reopen takes it back. Lets the poll''s watches and follows go once it has nothing left to announce. Internal: called from the triggers on ballots, invited_voters and polls, never by a client.';
