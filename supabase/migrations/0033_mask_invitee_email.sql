-- Masking an invitee's email address on the roster, for everyone but the
-- creator.
--
-- poll_invitees() used to hand back every invitee's email verbatim to
-- whoever could read the roster -- which, on a poll with show_voters on, is
-- every other invitee. That is a full address, PII, sitting in the RPC
-- response itself; a client-side display tweak would not have changed that,
-- since anyone can read the response body directly regardless of what the
-- page chooses to render. The address has to leave the server already
-- masked, for anyone who is not the creator.
--
-- The creator keeps the full address: they typed it in to invite this
-- person and still need it to tell two similar-looking addresses apart when
-- managing the list.


-- Keeps the first two and last two characters of the local part, with a
-- fixed run of asterisks between them regardless of how much was actually
-- removed -- so the mask does not itself disclose the address's length. A
-- local part of three characters or fewer keeps only its first character;
-- keeping two heads and two tails of something that short would leave
-- little masked at all. The domain is left untouched.
create or replace function "public"."mask_email"("p_email" "text") returns "text"
    language "sql" IMMUTABLE
    AS $$
  select case
    when position('@' in p_email) = 0 then p_email
    when length(split_part(p_email, '@', 1)) <= 3
      then left(split_part(p_email, '@', 1), 1) || '***@' || split_part(p_email, '@', 2)
    else left(split_part(p_email, '@', 1), 2) || '***' || right(split_part(p_email, '@', 1), 2)
           || '@' || split_part(p_email, '@', 2)
  end
$$;

ALTER FUNCTION "public"."mask_email"("p_email" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."mask_email"("p_email" "text") IS 'Partially hides the local part of an email address for display to someone other than the address''s owner or the poll creator. Not a security boundary on its own -- callers decide who gets the masked form and who gets the real one.';

-- Internal only, the same as poll_results_revealed and replace_scores: it is
-- called from within poll_invitees, which runs as this function's owner, so
-- no grant to authenticated is needed for that call to succeed.
REVOKE ALL ON FUNCTION "public"."mask_email"("p_email" "text") FROM PUBLIC;


create or replace function "public"."poll_invitees"("p_poll_id" "uuid") returns table("email" "text", "has_voted" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_is_creator boolean;
  v_is_invited boolean;
  v_show boolean;
  v_mode text;
begin
  select
    p.created_by = auth.uid(),
    p.show_voters,
    p.mode
  into v_is_creator, v_show, v_mode
  from polls p where p.id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- auth.uid() is null for an unauthenticated caller, which would make the
  -- comparison above NULL and every `not v_is_creator` test below NULL --
  -- i.e. not true, but not false either. EXECUTE is revoked from anon, so
  -- this is belt and braces; it is also exactly the shape of mistake 0010
  -- was written about.
  v_is_creator := coalesce(v_is_creator, false);

  select exists (
    select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
  ) into v_is_invited;

  if not v_is_creator and not v_is_invited then
    raise exception 'Poll not found';
  end if;

  if v_mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so it has no invitee list';
  end if;

  if not v_is_creator and not v_show then
    raise exception 'This poll does not show who has responded';
  end if;

  return query
  select
    case when v_is_creator then iv.email else mask_email(iv.email) end,
    case when v_show then exists (
      select 1 from ballots b
      join auth.users u on u.id = b.voter_id
      where b.poll_id = p_poll_id and lower(u.email) = iv.email
    ) else null::boolean end
  from invited_voters iv
  where iv.poll_id = p_poll_id
  order by iv.email;
end;
$$;

COMMENT ON FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") IS 'The invite roster for a poll: every invitee''s email and, where the poll shows respondents, whether they have voted. The creator sees full addresses; anyone else sees mask_email()''s partial form, because the roster is otherwise the one place this app hands one participant another participant''s PII.';
