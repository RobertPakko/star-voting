-- An option assignment names who was given which option, and the reader could
-- shape the count: remove options, give every option any capacity, change how
-- many each voter gets. With every capacity large and one option a voter, the
-- answer is each named voter's favourite; remove it and count again for their
-- second choice, and so on down the ballot. On a poll that shows who voted
-- but keeps its ballots private, that read every ballot's order back out.
--
-- So a count the reader shapes, and an assignment of a question that did not
-- ask for one, are now only for a poll that publishes its ballots, where they
-- disclose nothing the sheet does not. An assignment question on a poll with
-- private ballots still answers the one count its creator asked for, which
-- the voters were told about before they voted; it is `poll_tally`'s call,
-- with nothing removed and nothing given.
--
-- The count itself (`assignment_count`) is unchanged.

CREATE OR REPLACE FUNCTION "public"."poll_assignment"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[], "p_places" "jsonb", "p_per_voter" integer DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  -- A poll that hides its voters is refused by the count, in its own words.
  if found and v_poll.show_voters and not v_poll.show_ballots then
    if v_poll.kind <> 'assignment' then
      raise exception 'This poll keeps its ballots private, so it cannot be counted as an option assignment it did not ask for';
    end if;

    if coalesce(cardinality(p_excluded), 0) > 0 or p_places is not null or p_per_voter is not null then
      raise exception 'This poll keeps its ballots private, so its assignment can only be counted as it was asked';
    end if;
  end if;

  return assignment_count(p_poll_id, p_excluded, p_places, p_per_voter) - 'received';
end;
$$;

ALTER FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb", integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb", integer) FROM PUBLIC;
