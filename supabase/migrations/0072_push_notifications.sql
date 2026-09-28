-- Push notifications, and a say over which of the two channels a person hears
-- on.
--
-- Until now a poll wrote to people one way: an email, from inside Postgres,
-- about three moments -- being invited, voting opening, the results being
-- ready. This adds the second way, a web push to a phone or a browser, about
-- the same three moments, and a setting per account for each channel. It
-- deliberately adds no new moments and no new rules about who is told: every
-- push goes to exactly the people the matching email goes to, decided by the
-- same functions (poll_email_audience and poll_results_audience), so "nobody
-- is told what they just did" holds for both channels by construction.
--
-- Three things are new, and each is a table:
--
-- * notification_settings: one row per account that has changed anything,
--   holding an `email` and a `push` flag. No row means both on, so an account
--   that has never opened the settings page hears exactly what it always did.
--   An invitee with no account at all has no row either and keeps getting
--   the invitation email, which is the only way they could learn of the poll.
--
-- * push_subscriptions: a browser that has said yes, bound to the account
--   signed in when it did. An endpoint belongs to one account at a time -- a
--   shared browser that somebody else signs in to and turns notifications on
--   is theirs from then on -- and signing out takes the binding away (the
--   browser asks, through forget_push_subscription).
--
-- * poll_push_watches: the gap email could never close. An open poll's voters
--   gave no address and need no account, so neither email nor an account's
--   subscription can reach them. A watch is a browser saying "tell me about
--   this poll" through the link, with nothing else attached: no voter key, no
--   account, no name, and deliberately no timestamp, because the one thing an
--   anonymous poll must never let the database do is join a ballot to
--   whoever cast it, and a watch made in the same second as a ballot would be
--   exactly that join. It is filed against the group's first question, like
--   every other notice, and deleted once the results announcement has gone
--   out -- a watch is one-shot, and a browser's endpoint sitting on the rows
--   of every open poll it ever answered would be a record of which polls one
--   browser had been in.
--
-- The sending is not here, and cannot be. A push has to be signed with an
-- ECDSA P-256 key and its payload encrypted with ECDH and AES-GCM, and
-- pgcrypto can do neither, so the database hands each announcement to the
-- `send-push` Edge Function (supabase/functions/send-push) in one pg_net
-- request -- the message and every subscription it is for -- and the function
-- does the cryptography. It is best-effort exactly as the emails are: silent
-- wherever pg_net, Vault or the two secrets it reads are missing, which is
-- also what keeps the test database quiet.
--
-- All three tables are written through functions and read by nobody: RLS on,
-- no policies, no grants, like results_notices.

-- ---------------------------------------------------------------------------
-- The tables
-- ---------------------------------------------------------------------------

create table public.notification_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email boolean not null default true,
  push boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.notification_settings owner to postgres;
alter table public.notification_settings enable row level security;
revoke all on table public.notification_settings from anon, authenticated;

comment on table public.notification_settings is 'Which channels an account hears on. No row means both on. Read and written only through my_notification_settings and set_notification_settings.';

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions owner to postgres;
alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;

comment on table public.push_subscriptions is 'A browser that receives push notifications for the account it is bound to. Written through save_push_subscription and forget_push_subscription; read by nobody but the functions that send.';

create table public.poll_push_watches (
  poll_id uuid not null references public.polls (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  primary key (poll_id, endpoint)
);

alter table public.poll_push_watches owner to postgres;
alter table public.poll_push_watches enable row level security;
revoke all on table public.poll_push_watches from anon, authenticated;

comment on table public.poll_push_watches is 'A browser asking, through an open poll''s link, to be told when that poll opens for voting and when its results are ready. Carries nothing that identifies a voter, not even when it was made; filed against the group''s first question and deleted once the results are announced.';

-- ---------------------------------------------------------------------------
-- What a subscription may be
-- ---------------------------------------------------------------------------

-- The endpoint is a URL the Edge Function will POST to, and it arrives from
-- a browser -- anybody's, on the open-poll path. Left unchecked, that is a
-- way to make the function send requests wherever somebody likes. Every
-- browser that can subscribe hands out an endpoint on one of four push
-- services, so those four are the list: Google's (Chrome, Edge on Android,
-- Samsung, Opera, Brave), Mozilla's, Apple's, and Microsoft's (Edge on
-- Windows). The function checks the same list again before it sends.
create function public.push_subscription_valid(p_endpoint text, p_p256dh text, p_auth text)
returns boolean
    language sql immutable
    as $$
  select coalesce(
    length(p_endpoint) <= 2048
    and p_endpoint ~ '^https://([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)(:443)?/'
    -- An uncompressed P-256 point is 65 bytes, 87 characters of base64url;
    -- the auth secret is 16 bytes, 22 characters. A little slack either way
    -- for padding.
    and p_p256dh ~ '^[A-Za-z0-9_-]{86,88}={0,2}$'
    and p_auth ~ '^[A-Za-z0-9_-]{21,24}={0,2}$',
    false);
$$;

alter function public.push_subscription_valid(text, text, text) owner to postgres;
revoke all on function public.push_subscription_valid(text, text, text) from public;

comment on function public.push_subscription_valid(text, text, text) is 'Whether a browser''s push subscription is one this app will send to: an endpoint on one of the four push services, and keys of the right shape. Internal.';

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create function public.wants_email(p_email text)
returns boolean
    language sql stable security definer
    set search_path to 'public'
    as $$
  select not exists (
    select 1
    from notification_settings ns
    join auth.users u on u.id = ns.user_id
    where lower(u.email) = lower(p_email)
      and not ns.email
  );
$$;

alter function public.wants_email(text) owner to postgres;
revoke all on function public.wants_email(text) from public;

comment on function public.wants_email(text) is 'Whether an address should be emailed about a poll: true unless an account with that address has turned email off. An address with no account is always true -- the invitation is the only way it could hear of the poll. Internal.';

create function public.wants_push(p_user_id uuid)
returns boolean
    language sql stable security definer
    set search_path to 'public'
    as $$
  select coalesce((select push from notification_settings where user_id = p_user_id), true);
$$;

alter function public.wants_push(uuid) owner to postgres;
revoke all on function public.wants_push(uuid) from public;

comment on function public.wants_push(uuid) is 'Whether an account''s subscribed browsers should be pushed to: true unless it has turned push off. Internal.';

create function public.my_notification_settings(p_endpoint text default null)
returns jsonb
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in to change your notification settings';
  end if;

  -- `this_device` answers for the browser asking, which is the one it can
  -- honestly answer for: whether the subscription it holds is bound to this
  -- account. Another account's binding of the same endpoint is not this
  -- reader's business and reads as false.
  return jsonb_build_object(
    'email', coalesce((select email from notification_settings where user_id = v_user), true),
    'push', coalesce((select push from notification_settings where user_id = v_user), true),
    'this_device', p_endpoint is not null and exists (
      select 1 from push_subscriptions where endpoint = p_endpoint and user_id = v_user));
end;
$$;

alter function public.my_notification_settings(text) owner to postgres;
revoke all on function public.my_notification_settings(text) from public;
grant all on function public.my_notification_settings(text) to authenticated;

comment on function public.my_notification_settings(text) is 'The signed-in account''s two channel settings, and whether the browser holding this endpoint is one of its subscribed devices.';

create function public.set_notification_settings(p_email boolean, p_push boolean)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in to change your notification settings';
  end if;

  if p_email is null or p_push is null then
    raise exception 'Say whether you want each kind of notification';
  end if;

  insert into notification_settings (user_id, email, push)
  values (v_user, p_email, p_push)
  on conflict (user_id) do update
    set email = excluded.email, push = excluded.push, updated_at = now();
end;
$$;

alter function public.set_notification_settings(boolean, boolean) owner to postgres;
revoke all on function public.set_notification_settings(boolean, boolean) from public;
grant all on function public.set_notification_settings(boolean, boolean) to authenticated;

comment on function public.set_notification_settings(boolean, boolean) is 'Sets which of the two channels -- email and push -- the signed-in account hears about its polls on.';

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in to get notifications on this device';
  end if;

  if not push_subscription_valid(p_endpoint, p_p256dh, p_auth) then
    raise exception 'This browser''s push subscription is not one this app can send to';
  end if;

  -- An endpoint is one browser, and a browser is whoever is signed in to it
  -- now: saving it again under another account moves it rather than
  -- refusing, and saving it again under the same one refreshes its keys.
  insert into push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, v_user, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;

  -- A bound on what one account can make the sender do. Twenty is more
  -- browsers than anybody uses; the oldest go first, since a browser that
  -- has been reinstalled leaves its old endpoint behind and never comes back
  -- for it.
  delete from push_subscriptions
  where user_id = v_user
    and endpoint in (
      select endpoint from push_subscriptions
      where user_id = v_user
      order by created_at desc, endpoint
      offset 20);
end;
$$;

alter function public.save_push_subscription(text, text, text) owner to postgres;
revoke all on function public.save_push_subscription(text, text, text) from public;
grant all on function public.save_push_subscription(text, text, text) to authenticated;

comment on function public.save_push_subscription(text, text, text) is 'Binds this browser''s push subscription to the signed-in account, so it hears about that account''s polls.';

create function public.forget_push_subscription(p_endpoint text)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
begin
  if auth.uid() is null then
    return;
  end if;

  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

alter function public.forget_push_subscription(text) owner to postgres;
revoke all on function public.forget_push_subscription(text) from public;
grant all on function public.forget_push_subscription(text) to authenticated;

comment on function public.forget_push_subscription(text) is 'Stops this browser hearing about the signed-in account''s polls: on turning notifications off here, and on signing out.';

-- ---------------------------------------------------------------------------
-- Watching an open poll
-- ---------------------------------------------------------------------------

create function public.open_poll_watch(p_poll_id uuid, p_endpoint text, p_p256dh text, p_auth text)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_first polls;
begin
  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if not push_subscription_valid(p_endpoint, p_p256dh, p_auth) then
    raise exception 'This browser''s push subscription is not one this app can send to';
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  -- Closing is one act over the whole group, so the first question speaks
  -- for all of them. A closed poll has announced whatever it is going to
  -- announce: its results went out, or it had none to send.
  if v_first.closed_at is not null then
    raise exception 'This poll has closed, so there is nothing left to tell you about it';
  end if;

  -- The same kind of bound as an account's twenty devices, for a door with
  -- no account behind it.
  if (select count(*) from poll_push_watches where poll_id = v_first.id) >= 1000
     and not exists (
       select 1 from poll_push_watches where poll_id = v_first.id and endpoint = p_endpoint) then
    raise exception 'This poll cannot take any more notifications';
  end if;

  insert into poll_push_watches (poll_id, endpoint, p256dh, auth)
  values (v_first.id, p_endpoint, p_p256dh, p_auth)
  on conflict (poll_id, endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

alter function public.open_poll_watch(uuid, text, text, text) owner to postgres;
revoke all on function public.open_poll_watch(uuid, text, text, text) from public;
grant all on function public.open_poll_watch(uuid, text, text, text) to anon;
grant all on function public.open_poll_watch(uuid, text, text, text) to authenticated;

comment on function public.open_poll_watch(uuid, text, text, text) is 'Asks, through an open poll''s link, for this browser to be pushed a notification when the poll opens for voting and when its results are ready. Needs no account and records nothing about who asked.';

create function public.open_poll_unwatch(p_poll_id uuid, p_endpoint text)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_first polls;
begin
  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    return;
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  delete from poll_push_watches where poll_id = v_first.id and endpoint = p_endpoint;
end;
$$;

alter function public.open_poll_unwatch(uuid, text) owner to postgres;
revoke all on function public.open_poll_unwatch(uuid, text) from public;
grant all on function public.open_poll_unwatch(uuid, text) to anon;
grant all on function public.open_poll_unwatch(uuid, text) to authenticated;

comment on function public.open_poll_unwatch(uuid, text) is 'Takes back open_poll_watch for this browser.';

-- ---------------------------------------------------------------------------
-- What is sent, and to which browsers
-- ---------------------------------------------------------------------------

create function public.push_message(p_poll public.polls, p_event text)
returns jsonb
    language sql stable
    set search_path to 'public'
    as $$
  -- The poll's title is the notification's title. An email subject leaves it
  -- out because an inbox truncates a subject line to whatever fits; a
  -- notification has a line of its own for it and a body underneath, and the
  -- app's name is already drawn above both by the operating system.
  select jsonb_build_object(
    'title', coalesce(nullif(trim(p_poll.title), ''), 'A poll'),
    'body', case p_event
      when 'invite_options' then 'You''ve been invited to add options to this poll.'
      when 'invite_vote' then 'You''ve been invited to vote in this poll.'
      when 'opened' then 'The options are settled and voting is now open.'
      when 'results' then 'The results are ready.'
    end,
    -- Relative to the app's own address, which the service worker resolves
    -- against its scope, so the same message opens the right page from a
    -- local build as well as from choicelab.app.
    'path', '#/polls/' || short_poll_id(p_poll.id),
    -- One notification per poll on the screen: a later one about the same
    -- poll replaces the earlier rather than stacking under it.
    'tag', short_poll_id(p_poll.id));
$$;

alter function public.push_message(public.polls, text) owner to postgres;
revoke all on function public.push_message(public.polls, text) from public;

comment on function public.push_message(public.polls, text) is 'The notification sent about one of a poll''s three moments -- invite_options, invite_vote, opened, results. Internal.';

create function public.poll_push_targets(
  p_poll public.polls,
  p_emails text[],
  p_watchers boolean,
  p_actor uuid
) returns table (endpoint text, p256dh text, auth text)
    language sql stable security definer
    set search_path to 'public'
    as $$
  select distinct on (t.endpoint) t.endpoint, t.p256dh, t.auth
  from (
    -- Everybody the matching email is addressed to, on every browser they
    -- have turned notifications on in -- unless they have turned push off.
    select s.endpoint, s.p256dh, s.auth
    from push_subscriptions s
    join auth.users u on u.id = s.user_id
    where lower(u.email) = any (p_emails)
      and wants_push(s.user_id)

    union all

    -- And every browser watching the poll through its link. A watch is the
    -- one thing here with no account behind it, so the actor's address
    -- cannot leave it out the way it leaves them out of the list above; what
    -- can is their own browser, where it is bound to their account. That is
    -- the creator who pressed Open or Close, watching on the phone they
    -- pressed it on.
    select w.endpoint, w.p256dh, w.auth
    from poll_push_watches w
    where p_watchers
      and w.poll_id = p_poll.id
      and not exists (
        select 1 from push_subscriptions a
        where a.endpoint = w.endpoint and a.user_id = p_actor)
  ) t
  order by t.endpoint;
$$;

alter function public.poll_push_targets(public.polls, text[], boolean, uuid) owner to postgres;
revoke all on function public.poll_push_targets(public.polls, text[], boolean, uuid) from public;

comment on function public.poll_push_targets(public.polls, text[], boolean, uuid) is 'Every browser to push to about a poll: the subscribed devices of the addresses given, where push is on, and -- when asked -- the browsers watching it through its link, minus the actor''s own. Each endpoint once. Internal.';

create function public.send_push(p_targets jsonb, p_message jsonb)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_url text;
  v_secret text;
begin
  if p_targets is null or jsonb_array_length(p_targets) = 0 then
    return;
  end if;

  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return;
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'push_function_url'
  limit 1;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'push_function_secret'
  limit 1;

  if v_url is null or v_secret is null then
    return;
  end if;

  -- One request per announcement rather than one per browser, unlike the
  -- emails: a push endpoint is a URL on a push service, never shown to
  -- anybody, so sending them all to the function together discloses nothing
  -- to anyone -- and the function is what fans them out.
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object('message', p_message, 'targets', p_targets),
    timeout_milliseconds := 8000
  );
end;
$$;

alter function public.send_push(jsonb, jsonb) owner to postgres;
revoke all on function public.send_push(jsonb, jsonb) from public;

comment on function public.send_push(jsonb, jsonb) is 'Hands one notification and every browser it is for to the send-push Edge Function. Best-effort: silent where pg_net, Vault or either of its two secrets is missing. Internal: the one place this app talks to a push sender.';

create function public.push_poll(p_poll public.polls, p_event text, p_emails text[], p_watchers boolean)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_targets jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'endpoint', t.endpoint, 'p256dh', t.p256dh, 'auth', t.auth)), '[]'::jsonb)
  into v_targets
  from poll_push_targets(p_poll, p_emails, p_watchers, auth.uid()) t;

  perform send_push(v_targets, push_message(p_poll, p_event));
end;
$$;

alter function public.push_poll(public.polls, text, text[], boolean) owner to postgres;
revoke all on function public.push_poll(public.polls, text, text[], boolean) from public;

comment on function public.push_poll(public.polls, text, text[], boolean) is 'Pushes one of a poll''s moments to the browsers of the addresses given, and to its watchers when asked. Internal: called beside the matching email.';

create function public.forget_push_endpoints(p_endpoints text[])
returns void
    language sql security definer
    set search_path to 'public'
    as $$
  delete from push_subscriptions where endpoint = any (p_endpoints);
  delete from poll_push_watches where endpoint = any (p_endpoints);
$$;

alter function public.forget_push_endpoints(text[]) owner to postgres;
revoke all on function public.forget_push_endpoints(text[]) from public;
grant all on function public.forget_push_endpoints(text[]) to service_role;

comment on function public.forget_push_endpoints(text[]) is 'Drops browsers whose push service has said they are gone (404 or 410). Called by the send-push Edge Function, which is the only thing that ever sees the answer; nothing else may call it.';

-- ---------------------------------------------------------------------------
-- The three moments, now on both channels
-- ---------------------------------------------------------------------------

-- The email half learns the setting in the one place every letter passes
-- through, so no sender has to remember it. Otherwise verbatim.
create or replace function public.send_poll_email(
  p_poll_id uuid,
  p_to text,
  p_subject text,
  p_heading text,
  p_body_html text
) returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_api_key text;
  v_link text;
begin
  if not wants_email(p_to) then
    return;
  end if;

  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return;
  end if;

  select decrypted_secret into v_api_key
  from vault.decrypted_secrets
  where name = 'resend_api_key'
  limit 1;

  if v_api_key is null then
    return;
  end if;

  v_link := 'https://choicelab.app/star-voting/#/polls/' || short_poll_id(p_poll_id);

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_api_key
    ),
    body := jsonb_build_object(
      'from', 'STAR Voting <noreply@choicelab.app>',
      'to', jsonb_build_array(p_to),
      'subject', p_subject,
      'html', poll_email_html(p_heading, p_body_html, v_link)
    ),
    timeout_milliseconds := 8000
  );
end;
$$;

comment on function public.send_poll_email(uuid, text, text, text, text) is 'Posts one email about one poll to Resend, linking to that poll -- unless the address belongs to an account that has turned email off. Best-effort: silent where pg_net, Vault or the API key is missing. Internal: the one place this app talks to a mailer.';

create or replace function public.send_invite_email()
returns trigger
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_kind text;
  v_title_html text;
begin
  select * into v_poll from polls where id = new.poll_id;

  if not found then
    return new;
  end if;

  v_kind := poll_invite_kind(v_poll, new.email);

  if v_kind = 'none' then
    return new;
  end if;

  v_title_html := '<strong>' || email_escape(coalesce(v_poll.title, 'a poll')) || '</strong>';

  if v_kind = 'options' then
    perform send_poll_email(
      new.poll_id,
      new.email,
      'You''ve been added to a new poll',
      'Choose the options',
      'Choose options for ' || v_title_html || '. Sign in with this email address to add '
        || 'yours, and to say when you have finished.');
  else
    perform send_poll_email(
      new.poll_id,
      new.email,
      'You''ve been added to a new poll',
      'Your ballot is ready',
      'Vote now for ' || v_title_html || '. Sign in with this email address to see the '
        || 'options and cast your ballot.');
  end if;

  -- The same invitation, to the same one address, on whichever browsers it
  -- has turned notifications on in. Nobody watches a poll through its link
  -- before it exists, so there are no watchers to ask.
  perform push_poll(v_poll, 'invite_' || v_kind, array[lower(new.email)], false);

  return new;
end;
$$;

comment on function public.send_invite_email() is 'Writes to somebody added to a poll''s invite list, about whichever stage the poll is at, by email and by push as their settings say; nothing at all to the creator. Best-effort, like every notification here.';

create or replace function public.notify_poll_opened(p_poll_id uuid, p_by_itself boolean)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  -- Read here rather than passed in, because it is the same fact at both call
  -- sites and neither has to know it: this runs inside the confirmation, the
  -- removal or the button press that opened the poll, so whoever is signed in
  -- is whoever did it.
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    return;
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  -- One request per address rather than one request with every address in
  -- it: Resend would show every invitee every other invitee's address, which
  -- is what a poll with its respondents hidden promises not to do.
  for v_email in select * from poll_email_audience(v_first, p_by_itself, v_actor) loop
    perform send_poll_opened_email(v_first, v_email);
  end loop;

  -- The same people by push, and the browsers watching an open poll through
  -- its link -- which is the one audience an open poll has for this.
  perform push_poll(v_first, 'opened',
    array(select * from poll_email_audience(v_first, p_by_itself, v_actor)), true);
end;
$$;

comment on function public.notify_poll_opened(uuid, boolean) is 'Tells a poll''s voters that it has stopped collecting options and started taking votes, by email and by push, once for the group, leaving out whoever opened it. Internal: called by the two things that open a poll, which say between them whether the creator is hearing news.';

create or replace function public.notify_results_ready(p_poll_id uuid)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  -- The last ballot, the removal that left nobody to wait for, or the Close
  -- button: whichever of them crossed the line, it is this transaction and
  -- this is who is in it.
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  select * into v_poll from polls where id = p_poll_id;

  -- A poll on its way out -- the nightly purge, or the creator's own Delete
  -- button -- has nobody left to tell, and its notice row is cascading after
  -- it either way.
  if not found then
    return;
  end if;

  -- poll_group_members orders by question_position with nulls first, so this
  -- is question 1 of a group and the poll itself when it has no group. It is
  -- the row the invitation names, so the two emails about one poll point at
  -- the same page.
  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  if not poll_results_ready(v_first) then
    -- Back to taking votes. A poll that finishes again is a second result,
    -- and the people in it are told about it again.
    delete from results_notices where poll_id = v_first.id;

    -- A poll closed with nobody having voted is finished with nothing to
    -- announce, so its watches will never be answered. Gone now rather than
    -- left on the poll until the purge.
    if v_first.closed_at is not null then
      delete from poll_push_watches where poll_id = v_first.id;
    end if;
    return;
  end if;

  -- The once-only rule, and all of it: two ballots arriving together both run
  -- this, and the primary key decides which of them is the announcement.
  insert into results_notices (poll_id) values (v_first.id)
  on conflict (poll_id) do nothing;

  if not found then
    return;
  end if;

  -- One request per address rather than one request with every address in it;
  -- see the note at the top of this file.
  for v_email in select * from poll_results_audience(v_first, v_actor) loop
    perform send_results_ready_email(v_first, v_email);
  end loop;

  perform push_poll(v_first, 'results',
    array(select * from poll_results_audience(v_first, v_actor)), true);

  -- A watch has done its job once the results are out. Keeping it would leave
  -- this browser's endpoint on the poll for the rest of its six months, and
  -- a reopened poll that finishes again is not something a voter who asked
  -- once, weeks ago, is still waiting to hear.
  delete from poll_push_watches where poll_id = v_first.id;
end;
$$;

comment on function public.notify_results_ready(uuid) is 'Reconciles a poll''s results-ready announcement with whether it actually has a result: sends once when it crosses the line, by email and by push, to everybody but whoever crossed it, and forgets when a reopen takes it back. Internal: called from the triggers on ballots, invited_voters and polls, never by a client.';
