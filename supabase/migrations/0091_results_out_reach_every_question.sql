-- A poll of several questions finishing on its last vote tells every
-- question's page, not only the page of the question that vote was cast in.
--
-- An invite poll reveals its results when every invitee has answered every
-- question, and nothing closes it: `closed_at` stays null. The ballot that
-- does it announces its own question, and settle_winner then writes the winner
-- onto every question in the group -- but broadcast_poll_updated ignored a
-- change to the winner columns, so the other questions' topics heard nothing.
-- Somebody reading question 2 when the last vote landed on question 3 was left
-- on "In progress" until they reloaded.
--
-- The winner columns were quiet so that settling did not send the question
-- voted in a second message on top of its ballot's. announce() has since made
-- that a non-issue -- a topic is told once per transaction whatever asks
-- (0060) -- so the winner's write can speak again: once for each question it
-- lands on, and nothing extra for the one that was already told. It is also
-- precisely the moment a sibling's page needs: settle_winner writes only when
-- a question crosses the line in either direction.
--
-- results_announced_at and reminder_sent_at stay quiet. They change nothing
-- any page draws.

CREATE OR REPLACE FUNCTION "public"."broadcast_poll_updated"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_quiet text[] := array['results_announced_at', 'reminder_sent_at'];
begin
  if to_jsonb(NEW) - v_quiet is not distinct from to_jsonb(OLD) - v_quiet then
    return null;
  end if;

  perform broadcast_poll_change(NEW.id);
  return null;
end;
$$;
