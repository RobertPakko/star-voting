-- Match the invite email's footer to the sign-in email's, which dropped
-- "STAR Voting" from the footer line in favor of just the domain.

CREATE OR REPLACE FUNCTION "public"."send_invite_email"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_api_key text;
  v_poll_title text;
  v_poll_mode text;
  v_title_html text;
  v_link text;
  v_html text;
begin
  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return new;
  end if;

  select decrypted_secret into v_api_key
  from vault.decrypted_secrets
  where name = 'resend_api_key'
  limit 1;

  if v_api_key is null then
    return new;
  end if;

  select title, mode into v_poll_title, v_poll_mode
  from polls
  where id = new.poll_id;

  -- guard_invitee_changes already refuses an insert against a non-invite
  -- poll; this is just defensive.
  if v_poll_mode is distinct from 'invite' then
    return new;
  end if;

  v_title_html := replace(replace(replace(coalesce(v_poll_title, 'a poll'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  v_link := 'https://choicelab.app/star-voting/#/polls/' || new.poll_id::text;

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
                  You're invited to vote
                </h1>
                <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#5b5468;">
                  You've been invited to vote in&nbsp;<strong>$html$ || v_title_html || $html$</strong>. Sign in with this
                  email address to see the options and cast your ballot.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td align="center" style="border-radius:10px; background:linear-gradient(135deg,#7e14ff,#47bfff); background-color:#7e14ff;">
                      <a href="$html$ || v_link || $html$"
                         style="display:inline-block; padding:14px 36px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:10px;">
                        View poll &rarr;
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
      'to', jsonb_build_array(new.email),
      'subject', 'You''re invited to vote: ' || coalesce(v_poll_title, 'a poll'),
      'html', v_html
    ),
    timeout_milliseconds := 8000
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."send_invite_email"() OWNER TO "postgres";
