-- Two more things a time poll's schedule may say.
--
-- Both are additions to the jsonb `polls.schedule` already holds, so there is
-- no column to add and no constraint to move: `validate_schedule` is the whole
-- of what a schedule has to satisfy, and this replaces it. Every schedule that
-- was valid before is valid now -- both new keys are optional, and a poll made
-- without them behaves exactly as it did.
--
--     {
--       "timezone": "-07:00",
--       "timezone_label": "Mountain Time (Denver)",
--       "window": { "start": "09:00", "end": "22:00" },
--       "day_windows": { "2026-09-04": { "start": "18:00", "end": "22:00" } },
--       "desired_slots": 2,
--       "granularity": 60
--     }
--
-- **`day_windows` -- a Friday that is only free in the evening.** The daily
-- window was one pair of times for the whole poll, which asks a group with a
-- free Friday evening and a free Saturday morning to answer as if both days
-- ran nine to ten. Now a day may name its own hours, and `window` becomes two
-- things at once: the hours of any day that did not, and the union of all of
-- them -- which is the vertical axis the ballot's grid is drawn on, and the
-- reason it was stored in the first place. That union is what makes the
-- containment rule below more than tidiness: a day reaching outside `window`
-- is a day with windows the grid cannot draw.
--
-- **`timezone_label` -- what the creator called the offset.** Presentation,
-- and nothing computes with it. A poll is still held at a fixed UTC offset for
-- the reasons 0055 sets out and this does not reopen; what it does is stop the
-- offset being the only thing a voter is shown. The browser asks the reader's
-- own zone database what "Denver" reads on the poll's first day, stores the
-- number, and keeps the name beside it so the ballot can say "Mountain Time
-- (Denver) — UTC-06:00" instead of four digits. Checked here only for length
-- and type: a label that disagrees with its offset is a label the reader can
-- see disagreeing, because the two are always written together.
--
-- The dates in `day_windows` are the one thing in a schedule that names a day,
-- which looks like a contradiction of 0055's rule that the days in bounds are
-- exactly the days the options start on. It is not, and nothing here enforces
-- agreement between the two: `daysOf` in the browser is still the only answer
-- to *which* days a poll asks about, and an entry for a day the poll does not
-- ask about is ignored rather than obeyed. What an entry says is what the
-- hours are on a day that is already in bounds -- which the options can only
-- nearly answer, since the last start on a day falls a granule or two short of
-- that day's end and the grid has to grey out the difference rather than
-- guess it.


create or replace function "public"."validate_schedule"("p_schedule" jsonb) returns void
    language plpgsql immutable
    set "search_path" to 'public'
    as $$
declare
  v_start text := p_schedule #>> '{window,start}';
  v_end text := p_schedule #>> '{window,end}';
  v_label text;
  v_slots int;
  v_granularity int;
  v_day text;
  v_day_window jsonb;
  v_day_start text;
  v_day_end text;
begin
  if p_schedule is null or jsonb_typeof(p_schedule) <> 'object' then
    raise exception 'A time poll needs a schedule';
  end if;

  -- A fixed offset, never a named zone. A named zone spanning a DST
  -- transition gives one day 23 or 25 hours and a 1am that happens twice or
  -- not at all, which makes the generated option names ambiguous in precisely
  -- the way declaring a timezone was meant to prevent.
  --
  -- Unchanged, and worth saying so now that a poll can also carry the name of
  -- a zone: the name is a caption on this number and never a substitute for
  -- it. What resolves one to the other is the creator's browser, once, before
  -- the poll exists.
  if coalesce(p_schedule ->> 'timezone', '') !~ '^[+-][0-9]{2}:[0-9]{2}$' then
    raise exception 'A schedule''s timezone is a fixed UTC offset, like -07:00';
  end if;

  -- Optional, and only ever read by a person. Checked for being a string of a
  -- sane length, which is the whole of what can be wrong with a caption --
  -- there is no correct value to compare it against, and inventing one would
  -- mean shipping a zone database into Postgres to disagree with the browser's.
  if p_schedule ? 'timezone_label'
     and jsonb_typeof(p_schedule -> 'timezone_label') not in ('string', 'null') then
    raise exception 'A schedule''s timezone_label is a name for the offset, or null';
  end if;

  v_label := p_schedule ->> 'timezone_label';
  if length(coalesce(v_label, '')) > 80 then
    raise exception 'That timezone name is too long';
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

  -- ---- the days that ask something different ------------------------------

  if p_schedule ? 'day_windows'
     and jsonb_typeof(p_schedule -> 'day_windows') not in ('object', 'null') then
    raise exception 'A schedule''s day_windows is a set of dates with hours against them';
  end if;

  for v_day, v_day_window in
    select * from jsonb_each(coalesce(nullif(p_schedule -> 'day_windows', 'null'::jsonb), '{}'::jsonb))
  loop
    -- A date, and a real one: 'Friday' and '2026-02-31' are both keys that
    -- would sit in the jsonb quietly and match no day the calendar draws.
    -- The cast is what makes the second of those an error rather than a
    -- pattern that happens to fit. Safe inside an immutable function despite
    -- date_in being stable: what DateStyle changes is how an *ambiguous*
    -- literal is read, and the regex above has already refused everything but
    -- unambiguous ISO 8601.
    if v_day !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'A schedule''s day_windows are keyed by date, like 2026-09-04; got "%"', v_day;
    end if;

    begin
      perform v_day::date;
    exception when others then
      raise exception '"%" is not a date', v_day;
    end;

    if jsonb_typeof(v_day_window) <> 'object' then
      raise exception 'The hours for % are two times, like 18:00 and 22:00', v_day;
    end if;

    v_day_start := v_day_window ->> 'start';
    v_day_end := v_day_window ->> 'end';

    if coalesce(v_day_start, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
       or coalesce(v_day_end, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then
      raise exception 'The hours for % are two times, like 18:00 and 22:00', v_day;
    end if;

    if v_day_end <= v_day_start then
      raise exception 'The hours for % have to end after they start', v_day;
    end if;

    -- The containment rule, and the one that is load-bearing rather than
    -- fussy. `window` is the grid's vertical axis as well as the default for a
    -- day with no hours of its own, so a day reaching outside it is a day
    -- whose windows the ballot has no rows to draw -- the voter would be
    -- offered options they cannot mark and would score every one of them 0.
    -- Times of day are fixed-width here, so this is a text comparison and not
    -- an arithmetic one.
    if v_day_start < v_start or v_day_end > v_end then
      raise exception 'The hours for % have to sit inside the poll''s own % to %',
        v_day, v_start, v_end;
    end if;
  end loop;

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
  'Raises unless the jsonb handed in is a schedule a calendar can be drawn from. The front end enumerates the options, so nothing here can check that they agree with it; what it can check is that the grid itself is describable -- including that no day reaches outside the window the grid is drawn on. Internal.';

-- A CREATE OR REPLACE, so the REVOKE 0053 put on this function is still in
-- place and there is nothing to restate. That is the difference between this
-- migration and 0055's two: neither of those could be replaced, because each
-- gained a parameter.

comment on column "public"."polls"."schedule" is
  'How a time poll''s grid is laid out: {timezone, timezone_label?, window: {start, end}, day_windows?, desired_slots, granularity}. Only what cannot be recovered from the options -- the in-bounds days are exactly the dates the options start on, so the client derives those and the two can never disagree. `window` is both the hours of a day that day_windows does not name and the union of every day''s, which is the vertical axis the ballot is drawn on. `timezone_label` is a caption on the offset and nothing reads it. Null on an option poll; required on a time poll.';
