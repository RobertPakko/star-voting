-- Adds a denormalized creator email so the poll list can show "created by
-- X" without ever querying auth.users from the client (which isn't
-- exposed via the API). New rows get it automatically from the inserting
-- request's own JWT, so it can't be spoofed by a client-supplied value --
-- it's always the real creator. Existing rows are backfilled here via a
-- direct auth.users join, which only this migration's elevated session
-- can do -- the app itself never gets that access.
--
-- Note: the underlying table is still named "candidates" (see
-- 0001_init.sql) even though the app now calls these "options" in the UI.
-- That's a cosmetic rename at the app layer only; renaming the table
-- itself would mean touching every policy/function that references it for
-- no functional benefit.

alter table polls add column created_by_email text;

update polls p
set created_by_email = lower(u.email)
from auth.users u
where u.id = p.created_by and p.created_by_email is null;

alter table polls alter column created_by_email set not null;
alter table polls alter column created_by_email set default lower(auth.jwt() ->> 'email');
