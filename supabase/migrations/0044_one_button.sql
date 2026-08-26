-- One button, and it says Open poll.
--
-- The four emails ended up with four different buttons -- Add options, Open
-- poll, Cast your ballot, See the results -- each one named after the thing
-- its letter was about. Read one at a time that is fine; read as a set it is
-- four different-looking doors onto the same page, and the same page is what
-- every one of them opens: the poll. So the label is the same in all four,
-- and what the letter is about is the sentence above it, where it already
-- was.
--
-- That makes the button part of the letterhead rather than part of the
-- letter, so it moves into `poll_email_html` and stops being an argument.
-- Four call sites passing the same string is four places for it to drift,
-- which is the argument the shell itself was extracted on -- see
-- [`0043_the_emails_a_poll_sends.sql`](0043_the_emails_a_poll_sends.sql).
--
-- Both functions lose a parameter rather than gaining one, which cannot be
-- done in place: the old arities are dropped here and every caller is
-- replaced below, in this file, so nothing is left pointing at a signature
-- that no longer exists.


-- ---------------------------------------------------------------------------
-- The letterhead, with the button in it
-- ---------------------------------------------------------------------------

create or replace function public.poll_email_html(
  p_heading text,
  p_body_html text,
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

alter function public.poll_email_html(text, text, text) owner to postgres;
revoke all on function public.poll_email_html(text, text, text) from public;

comment on function public.poll_email_html(text, text, text) is
  'The card every email this app sends is: a heading, a sentence, and the button onto the poll. Internal: the one place the letterhead is written down.';

drop function if exists public.poll_email_html(text, text, text, text);


create or replace function public.send_poll_email(
  p_poll_id uuid,
  p_to text,
  p_subject text,
  p_heading text,
  p_body_html text
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
      'html', poll_email_html(p_heading, p_body_html, v_link)
    ),
    timeout_milliseconds := 8000
  );
end;
$$;

alter function public.send_poll_email(uuid, text, text, text, text) owner to postgres;
revoke all on function public.send_poll_email(uuid, text, text, text, text) from public;

comment on function public.send_poll_email(uuid, text, text, text, text) is
  'Posts one email about one poll to Resend, linking to that poll. Best-effort: silent where pg_net, Vault or the API key is missing. Internal: the one place this app talks to a mailer.';

drop function if exists public.send_poll_email(uuid, text, text, text, text, text);


-- ---------------------------------------------------------------------------
-- The letters, unchanged but for the argument they no longer pass
-- ---------------------------------------------------------------------------

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
        || 'yours, and to say when you have finished.');
  else
    perform send_poll_email(
      new.poll_id,
      new.email,
      'You''ve been added to a new poll',
      'Your ballot is ready',
      'Vote now for ' || v_title_html || '. Sign in with this email address to see the '
        || 'options and cast your ballot.');
  end if;

  return new;
end;
$$;

alter function public.send_invite_email() owner to postgres;
revoke all on function public.send_invite_email() from public;


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
      || email_escape(coalesce(p_poll.title, 'a poll')) || '</strong>.');
end;
$$;

alter function public.send_poll_opened_email(public.polls, text) owner to postgres;
revoke all on function public.send_poll_opened_email(public.polls, text) from public;


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
      || email_escape(coalesce(p_poll.title, 'a poll')) || '</strong>.');
end;
$$;

alter function public.send_results_ready_email(public.polls, text) owner to postgres;
revoke all on function public.send_results_ready_email(public.polls, text) from public;
