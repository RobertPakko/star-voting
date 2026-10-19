-- Messages sent from the contact page.
--
-- The contact page (`#/contact`) asks for a reply address and a message, and
-- the message lands here. Nothing in the app reads it back: the table is read
-- by hand, with the service role, from the dashboard's table editor or SQL
-- editor —
--
--   select created_at, email, message from contact_messages order by created_at desc;
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
end;
$$;

ALTER FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") TO "service_role";
