-- Hardening pass. Three issues found while validating the app end to end.

-- ---------------------------------------------------------------------------
-- 1. created_by_email was spoofable.
--
-- 0003 set it via a column DEFAULT, but a DEFAULT only applies when the
-- client omits the column. polls_insert's WITH CHECK only validated
-- created_by, so a client posting created_by_email explicitly could make a
-- poll display as "Created by <anyone>" in every invitee's list -- a
-- ready-made phishing hook ("Created by your-boss@work.com"). Verified
-- against the live API before writing this. Force the value from the
-- caller's own JWT so the client's input is ignored entirely.
-- ---------------------------------------------------------------------------

create or replace function set_poll_creator_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_by_email := lower(auth.jwt() ->> 'email');
  return new;
end;
$$;

drop trigger if exists trg_set_poll_creator_email on polls;
create trigger trg_set_poll_creator_email
  before insert on polls
  for each row execute function set_poll_creator_email();

-- ---------------------------------------------------------------------------
-- 2. Invited emails were only lowercased client-side.
--
-- Every access check compares against lower(auth.jwt() ->> 'email'), so a
-- row stored with any other casing silently never matches: that person is
-- invisible to the poll, can never vote, and -- because results unlock on
-- voted_count >= invited_count -- permanently blocks the results.
-- ---------------------------------------------------------------------------

create or replace function normalize_invited_email()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

drop trigger if exists trg_normalize_invited_email on invited_voters;
create trigger trg_normalize_invited_email
  before insert or update on invited_voters
  for each row execute function normalize_invited_email();

update invited_voters
set email = lower(trim(email))
where email is distinct from lower(trim(email));

-- ---------------------------------------------------------------------------
-- 3. The option list could change after voting had started.
--
-- candidates_insert/candidates_delete let the creator edit options at any
-- time. Adding one mid-poll leaves already-cast ballots with no score for
-- it, so its average is computed over a smaller denominator than its
-- rivals' and the comparison is no longer apples-to-apples. Deleting one
-- cascades scores away from ballots people already cast. Freeze the option
-- list as soon as the first ballot lands.
--
-- The `polls` existence check matters: deleting a poll cascades to
-- candidates, and without it this trigger would fire during that cascade
-- and make any poll that has votes impossible to delete.
-- ---------------------------------------------------------------------------

create or replace function guard_options_frozen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_id uuid;
begin
  if tg_op = 'DELETE' then
    v_poll_id := old.poll_id;
  else
    v_poll_id := new.poll_id;
  end if;

  -- Parent poll already gone => this is a cascade from deleting the poll
  -- itself, which is allowed.
  if not exists (select 1 from polls where id = v_poll_id) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if exists (select 1 from ballots where poll_id = v_poll_id) then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists trg_guard_options_frozen on candidates;
create trigger trg_guard_options_frozen
  before insert or delete on candidates
  for each row execute function guard_options_frozen();
