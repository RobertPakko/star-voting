-- Option assignment no longer answers `received`: how many options went to a
-- voter who gave them each number of stars. Beside the names of who got what,
-- which an assignment always shows, it could say how a named voter scored on
-- a poll that keeps its ballots private (with one voter on a level, exactly).
--
-- The count itself is unchanged. It is kept, renamed, as `assignment_count`,
-- granted to nobody, so the suite can still check the stars an answer
-- handed out; `poll_assignment`, which every door and `poll_tally` call, is
-- that count less `received`.

ALTER FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb", integer)
  RENAME TO "assignment_count";

CREATE FUNCTION "public"."poll_assignment"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[], "p_places" "jsonb", "p_per_voter" integer DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select assignment_count(p_poll_id, p_excluded, p_places, p_per_voter) - 'received';
$$;

ALTER FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb", integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb", integer) FROM PUBLIC;
