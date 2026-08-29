-- A poll's title and description are bounded by the database.
--
-- Every other typed field was already checked twice: once by the form, so it
-- can say which box is wrong, and once here, because the form is not the only
-- way in. These two had only the form, so an account calling the RPC directly
-- could store a title of any length and it would render on the poll list, on
-- the poll's own page, on the share card and in every invitation email.
--
-- The numbers match TITLE_MAX and POLL_DESCRIPTION_MAX in src/lib/limits.ts.
-- The ceilings themselves are asserted as well as the refusals: a case that
-- only checks that 101 characters fail would still pass if the limit moved.

begin;

do $$
declare
  v_poll uuid;
  v_group uuid;
  v_questions jsonb;
begin
  perform tests.sign_in('creator@example.com');

  perform tests.assert_raises('a title is a line, not a paragraph',
    format('select create_poll(%L, null, array[%L, %L], array[%L])',
           repeat('x', 101), 'Pizza', 'Sushi', 'voter1@example.com'),
    'title is too long');

  perform tests.assert_raises('and a description is a paragraph, not a chapter',
    format('select create_poll(%L, %L, array[%L, %L], array[%L])',
           'Lunch', repeat('y', 501), 'Pizza', 'Sushi', 'voter1@example.com'),
    'description is too long');

  -- A blank title is still its own refusal, in its own words, rather than
  -- being folded into the length check above it.
  perform tests.assert_raises('a title is still required',
    format('select create_poll(%L, null, array[%L, %L], array[%L])',
           '   ', 'Pizza', 'Sushi', 'voter1@example.com'),
    'Title is required');

  -- The ceilings themselves fit.
  v_poll := create_poll(repeat('x', 100), repeat('y', 500),
                        array['Pizza', 'Sushi'], array['voter1@example.com']);
  perform tests.assert_eq('100 characters of title and 500 of description fit',
    (select count(*)::int from polls
       where id = v_poll and length(title) = 100 and length(description) = 500), 1);

  -- ---- and the group path, which goes through the same insert_poll_row -----

  v_questions := jsonb_build_array(
    jsonb_build_object('title', 'One',
      'options', jsonb_build_array(jsonb_build_object('name', 'A'),
                                   jsonb_build_object('name', 'B'))),
    jsonb_build_object('title', 'Two',
      'options', jsonb_build_array(jsonb_build_object('name', 'C'),
                                   jsonb_build_object('name', 'D'))));

  perform tests.assert_raises('a multi-question poll is held to the same title',
    format('select create_poll_group(%L, null, %L::jsonb, array[%L])',
           repeat('x', 101), v_questions::text, 'voter1@example.com'),
    'title is too long');

  perform tests.assert_raises('and to the same description',
    format('select create_poll_group(%L, %L, %L::jsonb, array[%L])',
           'Dinner', repeat('y', 501), v_questions::text, 'voter1@example.com'),
    'description is too long');

  -- A question's own title is bounded where the loop can still say which
  -- question is wrong; on a poll of five, "too long" alone is a hunt.
  perform tests.assert_raises('a question title is bounded, and named by number',
    format('select create_poll_group(%L, null, %L::jsonb, array[%L])',
           'Dinner',
           jsonb_set(v_questions, '{1,title}', to_jsonb(repeat('q', 101)))::text,
           'voter1@example.com'),
    'title of question 2 is too long');

  -- And a group's own ceilings fit, question titles included.
  v_group := create_poll_group(
    repeat('x', 100), repeat('y', 500),
    jsonb_set(v_questions, '{0,title}', to_jsonb(repeat('q', 100))),
    array['voter1@example.com']);

  perform tests.assert_eq('a group takes 100 characters of question title',
    (select count(*)::int from polls
       where group_id = (select group_id from polls where id = v_group)
         and length(question_title) = 100), 1);
end $$;

rollback;
