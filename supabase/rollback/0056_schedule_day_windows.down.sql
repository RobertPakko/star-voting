-- Undo 0056_schedule_day_windows.sql.
--
-- Deliberately NOT in supabase/migrations/, for the reason 0055's down file
-- gives at length: everything in that directory is applied on merge.
--
--     psql -d <database> -f supabase/rollback/0056_schedule_day_windows.down.sql
--
-- 0056 added no column and no constraint. All it did was replace
-- `validate_schedule` and restate the comment on `polls.schedule`, so this
-- puts both back to the definitions 0055 gives, verbatim -- copied from
-- supabase/migrations/0055_schedule_polls.sql and not edited.
--
-- **It is not lossless, and cannot be.** Nothing is dropped, so every schedule
-- already stored keeps its `day_windows` and its `timezone_label` -- and the
-- restored function will happily accept more of both, because 0055's version
-- does not know the keys exist and ignores what it does not check. What is
-- lost is the checking: after this runs, a day may name hours reaching outside
-- the grid the ballot is drawn on, and nothing in the database will say so.
--
-- Rolling this back on its own is therefore only sensible alongside a front
-- end that no longer writes either key. Rolling back the feature entirely is
-- 0055's down file, which drops the column both live in.
--
-- A CREATE OR REPLACE either way, so there are no grants to restore: the
-- REVOKE 0053 put on this function has been in place throughout.


begin;

create or replace function "public"."validate_schedule"("p_schedule" jsonb) returns void
    language plpgsql immutable
    set "search_path" to 'public'
    as $$
declare
  v_start text := p_schedule #>> '{window,start}';
  v_end text := p_schedule #>> '{window,end}';
  v_slots int;
  v_granularity int;
begin
  if p_schedule is null or jsonb_typeof(p_schedule) <> 'object' then
    raise exception 'A time poll needs a schedule';
  end if;

  -- A fixed offset, never a named zone. A named zone spanning a DST
  -- transition gives one day 23 or 25 hours and a 1am that happens twice or
  -- not at all, which makes the generated option names ambiguous in precisely
  -- the way declaring a timezone was meant to prevent.
  if coalesce(p_schedule ->> 'timezone', '') !~ '^[+-][0-9]{2}:[0-9]{2}$' then
    raise exception 'A schedule''s timezone is a fixed UTC offset, like -07:00';
  end if;

  -- 24:00 is allowed as a time of day here, and only ever as the end: a
  -- window that runs to midnight is an ordinary thing to want, and '00:00'
  -- would say the day before's midnight. The v_end > v_start check below is
  -- what keeps it out of the start.
  if coalesce(v_start, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
     or coalesce(v_end, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then
    raise exception 'A schedule''s daily window is two times, like 08:00 and 22:00';
  end if;

  if v_end <= v_start then
    raise exception 'A schedule''s daily window has to end after it starts';
  end if;

  -- jsonb_typeof rather than a cast, because `'"3"'::jsonb ->> …` casts
  -- happily and a string where a number belongs is exactly the kind of drift
  -- this is here to catch.
  if jsonb_typeof(p_schedule -> 'granularity') <> 'number'
     or jsonb_typeof(p_schedule -> 'desired_slots') <> 'number' then
    raise exception 'A schedule''s granularity and desired_slots are numbers';
  end if;

  v_granularity := (p_schedule ->> 'granularity')::int;
  v_slots := (p_schedule ->> 'desired_slots')::int;

  -- The calendar draws a row per granule, and a granule that does not divide
  -- the hour draws a grid whose lines do not line up with the labels beside
  -- it. The same rule @mantine/schedule applies to intervalMinutes.
  if v_granularity < 1 or (60 % v_granularity <> 0 and v_granularity % 60 <> 0) then
    raise exception 'A schedule''s granularity divides an hour evenly, or is a whole number of hours';
  end if;

  if v_slots < 1 then
    raise exception 'A meeting is at least one granule long';
  end if;
end;
$$;

alter function "public"."validate_schedule"("p_schedule" jsonb) owner to "postgres";

comment on function "public"."validate_schedule"("p_schedule" jsonb) is
  'Raises unless the jsonb handed in is a schedule a calendar can be drawn from. The front end enumerates the options, so nothing here can check that they agree with it; what it can check is that the grid itself is describable. Internal.';

comment on column "public"."polls"."schedule" is
  'How a time poll''s grid is laid out: {timezone, window: {start, end}, desired_slots, granularity}. Only what cannot be recovered from the options -- the in-bounds days are exactly the dates the options start on, so the client derives those and the two can never disagree. Null on an option poll; required on a time poll.';

commit;
