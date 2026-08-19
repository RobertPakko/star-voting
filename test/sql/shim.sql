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

-- pg_cron, as far as the migrations can tell. The extension itself needs
-- shared_preload_libraries and is stripped from the schema before it is
-- applied (see test/run.sh), but the scheduling that goes with it is ordinary
-- SQL against the cron schema, and it is worth running: a squash that drops
-- it takes the nightly purge with it, silently, which is exactly what
-- happened once. With these stand-ins the schedule lands somewhere a case can
-- assert on, so losing it fails the suite instead of the database.
create schema if not exists cron;

create table if not exists cron.job (
  jobid    bigserial primary key,
  jobname  text unique,
  schedule text not null,
  command  text not null
);

create or replace function cron.schedule(job_name text, schedule text, command text)
  returns bigint
  language sql
  as $$
    insert into cron.job (jobname, schedule, command)
    values (job_name, schedule, command)
    on conflict (jobname)
      do update set schedule = excluded.schedule, command = excluded.command
    returning jobid
  $$;

create or replace function cron.unschedule(job_id bigint)
  returns boolean
  language sql
  as $$ delete from cron.job where jobid = job_id returning true $$;
