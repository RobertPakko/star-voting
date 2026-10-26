-- poll_winners() is dropped.
--
-- It was how the poll list learned which option each finished poll elected,
-- until 0047 put the answer on the poll row itself (`winner_name`, kept by
-- settle_winner) and every read that draws a badge started carrying it. From
-- then on nothing in the app called it; it was kept only for a browser still
-- holding the build before that change, for the minutes a deploy takes. That
-- window is long past.

drop function if exists public.poll_winners(uuid[]);
