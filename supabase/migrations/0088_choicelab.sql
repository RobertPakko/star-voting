-- The rebrand: STAR Voting is now ChoiceLab, and it is served from the root of
-- choicelab.app rather than from /star-voting/, with a poll at #/<id> rather
-- than #/polls/<id>.
--
-- Four functions spell one or the other out, and each is restated here whole,
-- copied from the baseline with only those strings changed:
--
--   poll_email_html     the letterhead: its logo, its wordmark, and the
--                       settings link in its footer
--   push_message        the path a tapped notification opens
--   send_poll_email     the link to the poll, and the sender's name
--   send_contact_email  the sender's name
--
-- `create or replace` keeps each function's owner, grants and comment, so
-- nothing else needs restating. The old addresses keep working regardless --
-- site-root/star-voting/ redirects to the root, and the app redirects
-- #/polls/<id> to #/<id> -- so a link in an email sent before this is not
-- broken by it, only longer.

CREATE OR REPLACE FUNCTION "public"."poll_email_html"("p_heading" "text", "p_body_html" "text", "p_link" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select $html$<!doctype html>
<html>
  <body style="margin:0; padding:0; background-color:#f2eefc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2eefc; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(126,20,255,0.12);">
            <tr>
              <td align="center" style="background-color:#ffffff; padding:40px 24px 24px; border-bottom:1px solid #f0edf7;">
                <img src="https://choicelab.app/logo.png" width="72" height="72" alt="ChoiceLab"
                     style="display:block; width:72px; height:72px; border-radius:16px;">
                <div style="margin-top:16px; font-size:20px; font-weight:700; color:#1a1523; letter-spacing:0.2px;">
                  ChoiceLab
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
                  <a href="https://choicelab.app/#/settings" style="color:#9691a3; text-decoration:underline;">Change your notification settings</a>.
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


CREATE OR REPLACE FUNCTION "public"."push_message"("p_poll" "public"."polls", "p_event" "text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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
      when 'reminder' then 'Reminder: you haven''t voted in '
        || coalesce(nullif(trim(p_poll.title), ''), 'this poll')
      when 'results' then 'The results are ready.'
    end,
    -- Relative to the app's own address, which the service worker resolves
    -- against its scope, so the same message opens the right page from a
    -- local build as well as from choicelab.app.
    'path', '#/' || short_poll_id(p_poll.id),
    -- One notification per poll on the screen: a later one about the same
    -- poll replaces the earlier rather than stacking under it.
    'tag', short_poll_id(p_poll.id));
$$;


CREATE OR REPLACE FUNCTION "public"."send_contact_email"("p_from" "text", "p_message" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_api_key text;
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

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_api_key
    ),
    body := jsonb_build_object(
      'from', 'ChoiceLab <noreply@choicelab.app>',
      'to', jsonb_build_array('RobertPakko@gmail.com'),
      'reply_to', p_from,
      'subject', 'Contact form: message from ' || p_from,
      'html', '<p style="font-family: sans-serif; color: #5b5468;">From '
        || email_escape(p_from) || ', via the contact page. Reply to answer them.</p>'
        || '<p style="font-family: sans-serif; white-space: pre-wrap;">'
        || email_escape(p_message) || '</p>'
    ),
    timeout_milliseconds := 8000
  );
end;
$$;


CREATE OR REPLACE FUNCTION "public"."send_poll_email"("p_poll_id" "uuid", "p_to" "text", "p_subject" "text", "p_heading" "text", "p_body_html" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_api_key text;
  v_link text;
begin
  if not wants_email(p_to) then
    return;
  end if;

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

  v_link := 'https://choicelab.app/#/' || short_poll_id(p_poll_id);

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_api_key
    ),
    body := jsonb_build_object(
      'from', 'ChoiceLab <noreply@choicelab.app>',
      'to', jsonb_build_array(p_to),
      'subject', p_subject,
      'html', poll_email_html(p_heading, p_body_html, v_link)
    ),
    timeout_milliseconds := 8000
  );
end;
$$;
