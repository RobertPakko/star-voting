-- A poll's link, shortened without being weakened.
--
-- A poll's id is its link, and a uuid written the way Postgres writes it is 36
-- characters carrying 122 random bits. The same sixteen bytes in base64url are
-- 22 characters carrying the same 122 bits: this is a spelling, not a new id
-- and not a weaker one. The app does the identical conversion in
-- src/lib/pollId.ts, and reads both spellings back, so every long link already
-- sent in one of these emails goes on resolving.
--
-- Nothing about the schema moves. `polls.id` is still a uuid, the five foreign
-- keys still point at it, and every RPC still takes `p_poll_id uuid`. The only
-- thing that changes is how the id is spelled in the one string this database
-- hands to a person.

CREATE OR REPLACE FUNCTION "public"."short_poll_id"("p_poll_id" "uuid") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
      -- Sixteen bytes encode to 24 characters, well under the 76 at which
      -- `encode` would start wrapping, so there is no newline to strip.
      select rtrim(translate(encode(uuid_send($1), 'base64'), '+/', '-_'), '=')
    $$;


ALTER FUNCTION "public"."short_poll_id"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."short_poll_id"("p_poll_id" "uuid") IS 'A poll id as it is spelled in a URL: the same sixteen bytes in base64url, 22 characters instead of 36. The app spells it the same way and reads both spellings, so older long links still resolve. Internal: used to build the link in send_poll_email.';


CREATE OR REPLACE FUNCTION "public"."send_poll_email"("p_poll_id" "uuid", "p_to" "text", "p_subject" "text", "p_heading" "text", "p_body_html" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  v_link := 'https://choicelab.app/star-voting/#/polls/' || short_poll_id(p_poll_id);

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
