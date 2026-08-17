-- Fixes "function gen_random_bytes(integer) does not exist", which made
-- every attempt to create an open poll fail.
--
-- 0013 built the share token with gen_random_bytes(), which comes from
-- pgcrypto. 0001 does `create extension if not exists pgcrypto`, but
-- Supabase installs extensions into the `extensions` schema, and
-- create_poll runs with `set search_path = public` -- so the function was
-- never resolvable from inside it. Nothing else had noticed, because the
-- gen_random_uuid() used for primary keys is core Postgres (pg_catalog),
-- not pgcrypto.
--
-- Rather than schema-qualify pgcrypto or widen the search_path -- both of
-- which bake in an assumption about where an extension happens to live --
-- build the token from gen_random_uuid(), which is always in scope. A v4
-- UUID carries 122 bits of entropy; the token is its 32 hex digits with
-- the dashes removed, which is already URL-safe.
--
-- Only the token line changes; the rest is 0013's create_poll verbatim.
-- No data to repair: create_poll is atomic (0009), so every failed attempt
-- rolled back whole and left nothing behind.

create or replace function create_poll(
  p_title text,
  p_description text,
  p_options text[],
  p_emails text[],
  p_mode text default 'invite',
  p_show_voters boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_id uuid;
  v_token text;
  v_opts text[];
  v_mails text[];
  v_bad text;
  i int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_mode is null or p_mode not in ('invite', 'open') then
    raise exception 'Unknown poll mode';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'Title is required';
  end if;

  -- Drop blanks but keep the author's ordering.
  select array_agg(trim(o) order by ord)
  into v_opts
  from unnest(p_options) with ordinality as t(o, ord)
  where trim(coalesce(o, '')) <> '';

  if coalesce(array_length(v_opts, 1), 0) < 2 then
    raise exception 'Add at least two options';
  end if;

  if p_mode = 'invite' then
    -- Normalize and dedupe invitees the same way every lookup does.
    select array_agg(distinct lower(trim(e)))
    into v_mails
    from unnest(p_emails) e
    where trim(coalesce(e, '')) <> '';

    if coalesce(array_length(v_mails, 1), 0) < 1 then
      raise exception 'Invite at least one voter';
    end if;

    select m into v_bad
    from unnest(v_mails) m
    where m !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    limit 1;

    if v_bad is not null then
      raise exception '"%" is not a valid email address', v_bad;
    end if;
  else
    -- 122 bits from a v4 UUID, hex digits only, so it needs no escaping in
    -- a URL. gen_random_uuid() is core Postgres -- no extension involved.
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;

  insert into polls (title, description, created_by, mode, show_voters, public_token)
  values (
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    auth.uid(),
    p_mode,
    coalesce(p_show_voters, true),
    v_token
  )
  returning id into v_poll_id;

  for i in 1 .. array_length(v_opts, 1) loop
    insert into candidates (poll_id, name, sort_order) values (v_poll_id, v_opts[i], i - 1);
  end loop;

  if p_mode = 'invite' then
    for i in 1 .. array_length(v_mails, 1) loop
      insert into invited_voters (poll_id, email) values (v_poll_id, v_mails[i]);
    end loop;
  end if;

  return v_poll_id;
end;
$$;

-- create-or-replace keeps the existing grants, but restate them so the end
-- state is readable here too (0010).
revoke execute on function create_poll(text, text, text[], text[], text, boolean) from public, anon;
grant execute on function create_poll(text, text, text[], text[], text, boolean) to authenticated;
