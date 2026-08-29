import { Link } from 'react-router-dom'
import { Anchor, Badge, Group, Stack, Text } from '@mantine/core'
import { badgeColor } from '../lib/badgeColors'

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
 * On an open poll it does not and must not — a share-link ballot is identified
 * by a key minted per question so one browser's ballots cannot be joined, and
 * `open_poll_group` returns no such flag on purpose. That is a rule about *the
 * server*, not about the reader: the browser already knows which questions it
 * has answered and is the one place entitled to, so there the flag comes out
 * of `lib/questionMarks.ts` and reaches the server no more than the remembered
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
  if (questions.length < 2) return null

  const index = questions.findIndex((q) => q.key === current)
  const previous = index > 0 ? questions[index - 1] : null
  const next = index >= 0 && index < questions.length - 1 ? questions[index + 1] : null

  return (
    <Stack gap="xs">
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
          return isCurrent ? (
            <Badge key={question.key} variant="filled" color={color} maw={220}>
              {question.title}
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
              </Badge>
            </Anchor>
          )
        })}
      </Group>
    </Stack>
  )
}
