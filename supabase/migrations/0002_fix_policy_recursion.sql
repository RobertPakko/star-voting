-- Fixes "infinite recursion detected in policy for relation polls":
-- polls_select checked invited_voters, whose own RLS policy checked back
-- into polls, forming a cycle. SECURITY DEFINER helper functions bypass
-- RLS on the table they query internally (they run as the table owner),
-- so routing the cross-table checks through them breaks the cycle.

create or replace function is_poll_creator(p_poll_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from polls where id = p_poll_id and created_by = auth.uid()
  );
$$;

create or replace function is_invited_to_poll(p_poll_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invited_voters
    where poll_id = p_poll_id and email = lower(auth.jwt() ->> 'email')
  );
$$;

grant execute on function is_poll_creator(uuid) to authenticated;
grant execute on function is_invited_to_poll(uuid) to authenticated;

drop policy if exists "polls_select" on polls;
create policy "polls_select" on polls
  for select
  using (created_by = auth.uid() or is_invited_to_poll(id));

drop policy if exists "candidates_select" on candidates;
create policy "candidates_select" on candidates
  for select
  using (is_poll_creator(poll_id) or is_invited_to_poll(poll_id));

drop policy if exists "candidates_insert" on candidates;
create policy "candidates_insert" on candidates
  for insert
  with check (is_poll_creator(poll_id));

drop policy if exists "candidates_delete" on candidates;
create policy "candidates_delete" on candidates
  for delete
  using (is_poll_creator(poll_id));

drop policy if exists "invited_voters_select" on invited_voters;
create policy "invited_voters_select" on invited_voters
  for select
  using (email = lower(auth.jwt() ->> 'email') or is_poll_creator(poll_id));

drop policy if exists "invited_voters_insert" on invited_voters;
create policy "invited_voters_insert" on invited_voters
  for insert
  with check (is_poll_creator(poll_id));

drop policy if exists "invited_voters_delete" on invited_voters;
create policy "invited_voters_delete" on invited_voters
  for delete
  using (is_poll_creator(poll_id));
