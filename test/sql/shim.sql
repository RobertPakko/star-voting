-- Stand-ins for the parts of a Supabase database that the migrations expect
-- to already exist. Supabase provides these; a bare Postgres does not.
--
-- This file deliberately fakes as little as possible. The migrations
-- themselves are applied verbatim on top of it, so the tally functions under
-- test are the ones that ship.

create schema if not exists extensions;
create schema if not exists vault;
create schema if not exists auth;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- The migrations call gen_random_uuid() unqualified, with a search_path of
-- 'public'. On Supabase the extension functions are reachable; here they need
-- to be put where the same unqualified calls will find them.
alter database :"db" set search_path to public, extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

-- The schema dump does an ALTER on this publication, so it has to exist. It
-- carries no tables here; nothing under test reads from it.
do $$
begin
  -- An empty publication on a cluster that is not set up for logical
  -- replication warns, which is true and beside the point here.
  set local client_min_messages = error;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Who is "signed in" right now. Supabase derives this from the request's JWT;
-- here it is one row that tests.sign_in() writes to. Everything downstream --
-- RLS policies, auth.uid(), auth.jwt() -- reads it the same way either side.
create table if not exists auth._session (
  id boolean primary key default true,
  user_id uuid,
  email text
);
insert into auth._session (id, user_id, email)
values (true, null, null)
on conflict (id) do nothing;

create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select user_id from auth._session where id $$;

create or replace function auth.jwt() returns jsonb
  language sql stable
  as $$
    select case
             when email is null then '{}'::jsonb
             else jsonb_build_object('email', email)
           end
    from auth._session where id
  $$;
