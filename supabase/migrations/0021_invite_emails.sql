-- Email an invitee the moment they're added to a poll.
--
-- invited_voters only ever gains rows through create_poll (there is no
-- "invite more people later" feature yet), so a single AFTER INSERT trigger
-- on that table covers every current path to an invitation -- and will keep
-- covering it if a later migration adds another way to invite someone,
-- since that path would insert into the same table.
--
-- The trigger calls Resend's HTTP API directly through pg_net rather than
-- going through a separate Edge Function: everything else server-side in
-- this app already lives in SQL, and pg_net was already enabled as an
-- extension. The API key is read from Supabase Vault at send time rather
-- than baked into the migration, since a migration file is committed to the
-- repo and a secret is not.
--
-- pg_net and Vault only exist on a real Supabase project -- the throwaway
-- database the test suite builds has neither (see test/run.sh), and every
-- existing test that creates an invite-mode poll would otherwise fail the
-- moment this trigger fires. The function checks for both schemas first and
-- quietly does nothing if either is missing, so invitations work in
-- production without the tests needing to know pg_net exists at all.
--
-- Sending is best-effort: pg_net's http_post is async and this trigger never
-- looks at the response, so a Resend outage or a missing/expired API key
-- costs a poll's invitees an email, never the invitation itself. The invitee
-- is on the list and can sign in and vote regardless of whether the email
-- ever arrives.

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
                  Sent by STAR Voting &middot; choicelab.app
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


CREATE OR REPLACE TRIGGER "trg_send_invite_email"
    AFTER INSERT ON "public"."invited_voters"
    FOR EACH ROW EXECUTE FUNCTION "public"."send_invite_email"();
