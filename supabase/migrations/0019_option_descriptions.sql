-- Optional per-option descriptions.
--
-- The candidates table has carried a nullable "description" column since the
-- schema was first written, and both ballots already render it under the
-- option name -- but nothing ever wrote one, because create_poll() took names
-- alone. This adds the missing half: a parallel array of descriptions, paired
-- with p_options by position.
--
-- Pairing is done before blank options are dropped, so removing an empty row
-- from the middle of the create form cannot shift every description down onto
-- the wrong option. A missing, short or all-null p_option_descriptions is
-- normal rather than an error: most polls need no descriptions at all, and a
-- subscript past the end of a Postgres array is null, not a failure -- so an
-- older client that calls create_poll without the argument keeps working.
--
-- The old signature is dropped rather than left alongside the new one: two
-- overloads where one argument list is a prefix of the other are ambiguous to
-- PostgREST, which resolves an RPC by the arguments it is given.

DROP FUNCTION IF EXISTS "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean);

CREATE OR REPLACE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_poll_id uuid;
  v_token text;
  v_opts text[];
  v_descs text[];
  v_mails text[];
  v_bad text;
  i int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_mode is null or p_mode not in ('invite', 'open') then
    raise exception 'Unknown poll mode';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'Title is required';
  end if;

  -- Drop blanks but keep the author's ordering, carrying each option's
  -- description along with it so the two cannot come apart.
  select array_agg(trim(o) order by ord),
         array_agg(nullif(trim(coalesce(p_option_descriptions[ord], '')), '') order by ord)
  into v_opts, v_descs
  from unnest(p_options) with ordinality as t(o, ord)
  where trim(coalesce(o, '')) <> '';

  if coalesce(array_length(v_opts, 1), 0) < 2 then
    raise exception 'Add at least two options';
  end if;

  if p_mode = 'invite' then
    -- Normalize and dedupe invitees the same way every lookup does.
    select array_agg(distinct lower(trim(e)))
    into v_mails
    from unnest(p_emails) e
    where trim(coalesce(e, '')) <> '';

    if coalesce(array_length(v_mails, 1), 0) < 1 then
      raise exception 'Invite at least one voter';
    end if;

    select m into v_bad
    from unnest(v_mails) m
    where m !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    limit 1;

    if v_bad is not null then
      raise exception '"%" is not a valid email address', v_bad;
    end if;
  else
    -- 122 bits from a v4 UUID, hex digits only, so it needs no escaping in
    -- a URL. gen_random_uuid() is core Postgres -- no extension involved.
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;

  insert into polls (title, description, created_by, mode, show_voters, show_ballots, public_token)
  values (
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    auth.uid(),
    p_mode,
    coalesce(p_show_voters, true),
    coalesce(p_show_ballots, false),
    v_token
  )
  returning id into v_poll_id;

  for i in 1 .. array_length(v_opts, 1) loop
    insert into candidates (poll_id, name, description, sort_order)
    values (v_poll_id, v_opts[i], v_descs[i], i - 1);
  end loop;

  if p_mode = 'invite' then
    for i in 1 .. array_length(v_mails, 1) loop
      insert into invited_voters (poll_id, email) values (v_poll_id, v_mails[i]);
    end loop;
  end if;

  return v_poll_id;
end;
$_$;


ALTER FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[]) TO "authenticated";


COMMENT ON COLUMN "public"."candidates"."description" IS 'Optional detail shown under the option name on the ballot. Fixed at creation, like everything else about a poll.';
