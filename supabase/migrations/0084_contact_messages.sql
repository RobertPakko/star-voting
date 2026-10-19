-- Messages sent from the contact page.
--
-- The contact page (`#/contact`) asks for a reply address and a message, and
-- the message lands here — and is emailed to the site's owner, with the
-- sender's address as its Reply-To, so answering it is pressing Reply. Nothing
-- in the app reads it back: the table is the record, read by hand with the
-- service role from the dashboard's table editor or SQL editor —
--
--   select created_at, email, message from contact_messages order by created_at desc;
--
-- The email goes the way every email this app sends goes — Resend through
-- `pg_net`, with the key read from Vault — and is best-effort in the same way:
-- silent where either is missing, never failing the insert, sent once. So a
-- message whose email went nowhere is still in the table.
--
-- Row-level security is on with no policies and there are no table grants, the
-- shape every table in this schema has that the browser never touches. The
-- one way in is `send_contact_message`, which is granted to `anon` as well as
-- `authenticated`: the page is public, like About and Donate, and the reader
-- most likely to have something to say is the one who arrived on a share link
-- and has never signed in. That makes it the one function `anon` may call that
-- is not an `open_poll_*` one, and it can do exactly one thing — add a row
-- nobody it can reach will ever read.
--
-- A door anybody can open needs a bound on how wide, so the function caps:
--
--  * the lengths, at the numbers `src/lib/limits.ts` carries for the form;
--  * the address, at the shape `invited_voters_email_ck` already asks of one;
--  * one session, signed in or anonymous, at five messages a day;
--  * and the table, at a hundred messages an hour from everybody together —
--    which is the only bound there is on a caller with no session at all, and
--    stops a script filling the table without stopping anybody real.
--
-- `user_id` records who was signed in, if anybody, so a message can be told
-- apart from a stranger's; it is null for a reader with no session, and set
-- null if the account is deleted.

CREATE TABLE IF NOT EXISTS "public"."contact_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email" "text" NOT NULL,
    "message" "text" NOT NULL,
    "user_id" "uuid",
    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contact_messages_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "auth"."users"("id") ON DELETE SET NULL
);

ALTER TABLE "public"."contact_messages" OWNER TO "postgres";

COMMENT ON TABLE "public"."contact_messages" IS 'Messages sent from the contact page, read by hand with the service role. Written only by send_contact_message; nothing in the app reads them.';

CREATE INDEX IF NOT EXISTS "contact_messages_created_at_idx"
    ON "public"."contact_messages" USING "btree" ("created_at");

ALTER TABLE "public"."contact_messages" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."contact_messages" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."contact_messages" FROM "anon";
REVOKE ALL ON TABLE "public"."contact_messages" FROM "authenticated";
GRANT ALL ON TABLE "public"."contact_messages" TO "service_role";

-- The letter to the site's owner. Plain on purpose: it is not a poll's email,
-- so it has no button onto a poll and no footer about notification settings,
-- and it goes to one fixed address rather than through `wants_email`.
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
      'from', 'STAR Voting <noreply@choicelab.app>',
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

ALTER FUNCTION "public"."send_contact_email"("p_from" "text", "p_message" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."send_contact_email"("p_from" "text", "p_message" "text") IS 'Emails one contact-page message to the site''s owner, with the sender as Reply-To. Best-effort: silent where pg_net, Vault or the API key is missing. Internal.';

REVOKE ALL ON FUNCTION "public"."send_contact_email"("p_from" "text", "p_message" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."send_contact_email"("p_from" "text", "p_message" "text") TO "service_role";

CREATE OR REPLACE FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := btrim(coalesce(p_email, ''));
  v_message text := btrim(coalesce(p_message, ''));
  v_user uuid := auth.uid();
begin
  if v_email = '' then
    raise exception 'Enter an email address so a reply can reach you';
  end if;
  if length(v_email) > 254 then
    raise exception 'That email address is too long';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'That does not look like an email address';
  end if;
  if v_message = '' then
    raise exception 'Write a message to send';
  end if;
  if length(v_message) > 5000 then
    raise exception 'Messages can be at most 5000 characters';
  end if;

  if v_user is not null and (
    select count(*) from contact_messages
    where user_id = v_user and created_at > now() - interval '1 day'
  ) >= 5 then
    raise exception 'You have sent several messages today already. Please try again tomorrow';
  end if;

  if (
    select count(*) from contact_messages where created_at > now() - interval '1 hour'
  ) >= 100 then
    raise exception 'A lot of messages have arrived in the last hour. Please try again later';
  end if;

  insert into contact_messages (email, message, user_id)
  values (v_email, v_message, v_user);

  perform send_contact_email(v_email, v_message);
end;
$$;

ALTER FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") TO "service_role";
