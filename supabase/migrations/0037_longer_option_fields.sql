-- An option name may be 150 characters and its description 900, not 100 and
-- 500.
--
-- Both were chosen when suggestions were the only way into `candidates`, and
-- both turned out to be a size smaller than what people write. 100 was a
-- *label's* length rather than an option's: real options carry a subtitle, an
-- author, a year, a "(vegetarian)", and a writer eight characters over the
-- line was being asked to abbreviate the thing being voted on so that the
-- ballot read worse. 500 was one paragraph of description where people were
-- writing two -- and a description is the one field on a ballot that is
-- allowed to be prose: the case for an option, a menu, a couple of caveats.
--
-- The reason a ceiling exists at all is unchanged, and is not about taste:
-- the suggestion path lets a whole group write to this table, so every field
-- it can reach needs a bound. A name is still a label rather than an essay,
-- and the description under it is still where anything longer belongs.
--
-- One function changes, because there has been only one place to change since
-- the creator's own edits started going through it: `insert_option` holds the
-- field rules for both paths, and `create_poll`, `create_poll_group`,
-- `suggest_option`, `open_poll_suggest_option` and `creator_add_option` all
-- arrive here. `src/lib/limits.ts` carries the same numbers for the form,
-- which is where a writer is told which field is too long and by how much;
-- the database is still what decides.
CREATE OR REPLACE FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_next int;
  v_count int;
begin
  if v_name is null then
    raise exception 'Give the option a name';
  end if;

  -- A name is a label on a ballot and a description is a couple of lines
  -- under it. Neither cap is near what a real option needs; they are here
  -- because the suggestion path lets a whole group write to this table.
  if length(v_name) > 150 then
    raise exception 'That option name is too long';
  end if;

  if length(v_description) > 900 then
    raise exception 'That description is too long';
  end if;

  if exists (
    select 1 from candidates c
    where c.poll_id = p_poll.id and lower(c.name) = lower(v_name)
  ) then
    raise exception '"%" is already on the list', v_name;
  end if;

  select count(*)::int, coalesce(max(sort_order), -1) + 1
  into v_count, v_next
  from candidates where poll_id = p_poll.id;

  -- A ballot is a list somebody has to read to the end before scoring any of
  -- it, and a shared list with nothing stopping it grows until nobody does.
  if v_count >= 50 then
    raise exception 'This poll already has as many options as it can hold';
  end if;

  -- Arrival order, which is the order everyone watching the page has been
  -- reading the list in already.
  insert into candidates (poll_id, name, description, sort_order)
  values (p_poll.id, v_name, v_description, v_next);
end;
$$;
