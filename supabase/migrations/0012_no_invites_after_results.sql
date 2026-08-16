-- Close the late-invite window.
--
-- Adding an invitee to a poll whose results were already visible re-locked
-- the results and let the new person vote. Since the creator had already
-- seen the standings, they could add an ally and tell them where things
-- stood -- that person then votes with information nobody else had.
--
-- The rule: adding is fine while results are still locked ("I forgot
-- Dave"), and blocked once they have been revealed. Removal was never a
-- vector here, since anyone who has voted is already unremovable.
--
-- Note this cannot misfire during create_poll(): it requires at least one
-- ballot to exist, and a poll being created has none.

create or replace function guard_invitee_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_id uuid;
  v_invited int;
  v_voted int;
begin
  if tg_op = 'DELETE' then
    v_poll_id := old.poll_id;
  else
    v_poll_id := new.poll_id;
  end if;

  -- Parent poll already gone => cascade from deleting the poll itself.
  if not exists (select 1 from polls where id = v_poll_id) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'INSERT' then
    if exists (select 1 from polls where id = v_poll_id and closed_at is not null) then
      raise exception 'Cannot invite people to a poll that has been closed';
    end if;

    select count(*) into v_invited from invited_voters where poll_id = v_poll_id;
    select count(*) into v_voted from ballots where poll_id = v_poll_id;

    if v_invited > 0 and v_voted >= v_invited then
      raise exception 'Cannot invite people once the results have been revealed';
    end if;

    return new;
  end if;

  if exists (
    select 1
    from ballots b
    join auth.users u on u.id = b.voter_id
    where b.poll_id = v_poll_id and lower(u.email) = old.email
  ) then
    raise exception 'Cannot remove someone who has already voted';
  end if;

  return old;
end;
$$;
