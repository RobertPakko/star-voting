-- The invite roster masks an email address for everyone but the poll's
-- creator.
--
-- poll_invitees() is read by every invitee on a poll that shows respondents,
-- not just the creator, so a full address returned there is handed to
-- whoever else is on the list -- PII sitting in the RPC response itself,
-- which no amount of hiding it on screen would fix. The creator alone gets
-- the real address back, since they typed it in to invite this person and
-- still need to tell similar-looking addresses apart when managing the list.

begin;

do $$
declare
  v_poll uuid;
  v_roster jsonb;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                        array['waterfallcanyon@example.com', 'ab@example.com'],
                        'invite', true, false);

  -- poll_invitees orders by email, so the short address sorts first: 'ab...'
  -- before 'wa...'.

  -- The creator sees every address in full.
  select jsonb_agg(row_to_json(r)) into v_roster
  from poll_invitees(v_poll) r;

  perform tests.assert_eq('the creator sees the short address in full',
    v_roster -> 0 ->> 'email', 'ab@example.com');
  perform tests.assert_eq('and the long one too',
    v_roster -> 1 ->> 'email', 'waterfallcanyon@example.com');

  -- An invitee reading the same roster gets everybody's address masked,
  -- their own included.
  perform tests.sign_in('waterfallcanyon@example.com');

  select jsonb_agg(row_to_json(r)) into v_roster
  from poll_invitees(v_poll) r;

  perform tests.assert_eq('a local part of three characters or fewer keeps only its first',
    v_roster -> 0 ->> 'email', 'a***@example.com');
  perform tests.assert_eq('a longer local part keeps its first two and last two characters',
    v_roster -> 1 ->> 'email', 'wa***on@example.com');

  -- The mask does not depend on who happens to be asking, only on who they
  -- are relative to the poll.
  perform tests.sign_in('ab@example.com');

  select jsonb_agg(row_to_json(r)) into v_roster
  from poll_invitees(v_poll) r;

  perform tests.assert_eq('every invitee gets the same masked view',
    v_roster -> 1 ->> 'email', 'wa***on@example.com');
end $$;

rollback;
