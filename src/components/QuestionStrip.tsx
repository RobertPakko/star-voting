import { useEffect, useLayoutEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Anchor, Badge, Group, Stack, Text, VisuallyHidden } from '@mantine/core'
import { badgeColor } from '../lib/badgeColors'
import { announce } from '../lib/announce'
import { noteArrival, noteLeaving, slideAlong } from '../lib/questionSlide'

/**
 * The question last announced, by the poll it belongs to (its first
 * question's key) and its own. Held here rather than in the component because
 * the strip is re-mounted on a crossing — the card it sits in is replaced —
 * and a ref would forget which question it had been showing at exactly the
 * moment that is the news.
 */
let lastShown: { poll: string; question: string } | null = null

/**
 * Where you are in a poll that asks more than one question, and how to reach
 * the rest of it.
 *
 * A multi-question poll is several polls under the hood, each with its own
 * ballot, its own tally and its own address. This is the only thing on screen
 * that holds them together as one poll: it names the questions in order,
 * marks the one being read, and puts the next and previous within one tap. Without
 * it a voter who answered question 1 would be looking at a finished poll with
 * nowhere to go.
 *
 * It renders nothing at all for a poll that asks one question. That is the
 * common case and it must look exactly as it always has: no strip, no
 * counter, no empty row where a strip would be.
 *
 * **The mark means "this question is behind you", and which fact makes that
 * true is whichever stage the poll is in.** A poll still collecting its
 * options has no ballots to have cast, so the mark is the reader's
 * confirmation of that question's list; once it is taking votes it is their
 * ballot. The strip is on both cards, in the same place inside each, because
 * a poll of five questions collects five lists as surely as it takes five
 * ballots.
 *
 * **Marks are shown only where they are honest, and the two ways in are honest
 * about different things.** On an invite poll the server knows what this
 * account has answered and finished adding to, and `poll_group` says so.
 * On an open poll it knows the same for a reader who is signed in, whose
 * share-link ballots carry their account, and `open_poll_group` says so on
 * every device. For a reader who is signed out it does not and must not — a
 * ballot cast with nobody signed in is identified by a key minted per question
 * so one browser's ballots cannot be joined, and `open_poll_group` returns no
 * flag for them on purpose. That is a rule about *the server*, not about the
 * reader: the browser already knows which questions it has answered and is
 * the one place entitled to, so there the flag comes out of
 * `lib/questionMarks.ts` and reaches the server no more than the remembered
 * voter name does.
 *
 * This component asks for none of that. It takes a boolean per question and
 * colours a badge with it; where the boolean came from is the page's business.
 *
 * **And no boolean at all means no mark**, which is the third honest answer
 * and the one a finished poll gives: *done* and *outstanding* would be a
 * distinction about a ballot nobody can still cast, and *outstanding* in
 * particular a nudge towards something the poll will no longer accept.
 */
export function QuestionStrip({
  questions,
  current,
  hrefFor,
}: {
  /**
   * Every question in the poll, in order. Fewer than two renders nothing.
   *
   * `answered` left undefined marks nothing, in either direction; see above.
   */
  questions: { key: string; position: number; title: string; answered?: boolean }[]
  /** The `key` of the question being read. */
  current: string
  /** Where a question lives, by its `key`. */
  hrefFor: (key: string) => string
}) {
  const index = questions.findIndex((q) => q.key === current)
  const here = index >= 0 ? questions[index] : null
  const pollKey = questions[0]?.key ?? ''
  const order = questions.map((q) => q.key).join(' ')

  // Walking between questions slides the question's half of the page along a
  // row; see lib/questionSlide.ts. The strip is what knows which way the poll
  // was walked, as it arrives on a question — from the question it was just
  // showing, or from the strip that left a moment ago — and what the slide is
  // drawn below.
  const root = useRef<HTMLDivElement>(null)
  const showing = useRef<string | null>(null)
  useLayoutEffect(() => {
    noteArrival(root.current, pollKey, current, order.split(' '), showing.current)
    showing.current = current
  }, [current, pollKey, order])

  // Going, copied as it goes so the strip that replaces it can slide this
  // question's half away. Only when it unmounts, which is while the page being
  // left is still in the document; by the time a cleanup runs for an update,
  // what stood after the strip may already have been replaced.
  useLayoutEffect(() => {
    const strip = root.current
    return () => noteLeaving(strip)
  }, [])

  // And what stands after it slides in, on every render while the crossing is
  // under way: a ballot replacing its skeleton, or a tally landing in place of
  // the shape that stood in for it, joins the movement where it has got to.
  useLayoutEffect(() => {
    slideAlong(root.current, pollKey, current)
  })

  // Moving between the questions of a poll keeps the page and its title, so a
  // screen reader hears nothing of it — least of all when answering one
  // carries the voter on to the next by itself. Said here, once per crossing,
  // and not on arriving at the poll, whose title has just been said.
  const total = questions.length
  const heading = here ? `Question ${index + 1} of ${total}: ${here.title}` : null
  useEffect(() => {
    if (!heading || total < 2) return
    if (lastShown?.poll === pollKey && lastShown.question !== current) announce(heading)
    lastShown = { poll: pollKey, question: current }
  }, [heading, pollKey, current, total])

  if (questions.length < 2) return null

  const previous = index > 0 ? questions[index - 1] : null
  const next = index >= 0 && index < questions.length - 1 ? questions[index + 1] : null

  return (
    <Stack gap="xs" ref={root}>
      <Group justify="space-between" wrap="nowrap" gap="sm" align="center">
        {/* The counter, not the title: the title is the page heading right
            below this, and saying it twice would push the ballot down for
            nothing. */}
        <Text size="sm" fw={500}>
          {index >= 0
            ? `Question ${index + 1} of ${questions.length}`
            : `${questions.length} questions`}
        </Text>
        <Group gap="xs" wrap="nowrap">
          {previous && (
            <Anchor component={Link} to={hrefFor(previous.key)} size="sm">
              ← Previous
            </Anchor>
          )}
          {next && (
            <Anchor component={Link} to={hrefFor(next.key)} size="sm">
              Next →
            </Anchor>
          )}
        </Group>
      </Group>

      {/* Every question by name, so the poll can be taken in whole and any
          part of it reached directly — a voter who wants to change one
          answer should not have to walk back through the others. */}
      <Group gap="xs">
        {questions.map((question) => {
          const isCurrent = question.key === current
          // Filled says which question is open; the hue says whether it has
          // been answered, and says nothing where there is nothing left to
          // say — which is the whole of the difference between a strip on a
          // poll still taking votes and one on a poll that has finished.
          const color =
            question.answered === undefined
              ? badgeColor.unmarked
              : question.answered
                ? badgeColor.done
                : badgeColor.outstanding
          // The hue in words, for a reader who cannot see it.
          const said =
            question.answered === undefined
              ? null
              : question.answered
                ? ' (answered)'
                : ' (not answered)'
          return isCurrent ? (
            <Badge key={question.key} variant="filled" color={color} maw={220} aria-current="step">
              {question.title}
              {said && <VisuallyHidden>{said}</VisuallyHidden>}
            </Badge>
          ) : (
            <Anchor
              key={question.key}
              component={Link}
              to={hrefFor(question.key)}
              underline="never"
            >
              <Badge variant="light" color={color} maw={220} style={{ cursor: 'pointer' }}>
                {question.title}
                {said && <VisuallyHidden>{said}</VisuallyHidden>}
              </Badge>
            </Anchor>
          )
        })}
      </Group>
    </Stack>
  )
}
