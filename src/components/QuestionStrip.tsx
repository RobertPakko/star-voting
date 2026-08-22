import { Link } from 'react-router-dom'
import { Anchor, Badge, Card, Group, Stack, Text } from '@mantine/core'
import { badgeColor, countBadge } from '../lib/badgeColors'

/**
 * Where you are in a poll that asks more than one question, and how to reach
 * the rest of it.
 *
 * A multi-question poll is several polls under the hood, each with its own
 * ballot, its own tally and its own address. This is the only thing on screen
 * that says so is not the case: it names the poll's questions in order, marks
 * the one being read, and puts the next and previous within one tap. Without
 * it a voter who answered question 1 would be looking at a finished poll with
 * nowhere to go.
 *
 * It renders nothing at all for a poll that asks one question. That is the
 * common case and it must look exactly as it always has: no strip, no
 * counter, no empty row where a strip would be.
 *
 * **Answered marks are shown only where they are honest.** On an invite poll
 * the server knows which questions this account has answered and says so. On
 * an open poll it does not and must not: a share-link ballot is identified by
 * a key minted per question so that one browser's ballots cannot be joined,
 * and `open_poll_group` returns no such flag. So `answered` simply arrives
 * undefined there and no question is marked, rather than being guessed at.
 */
export function QuestionStrip({
  questions,
  current,
  hrefFor,
}: {
  /** Every question in the poll, in order. Fewer than two renders nothing. */
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
    <Card withBorder p="sm">
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
            return isCurrent ? (
              <Badge key={question.key} variant="filled" color={badgeColor.outstanding} maw={220}>
                {question.title}
              </Badge>
            ) : (
              <Anchor
                key={question.key}
                component={Link}
                to={hrefFor(question.key)}
                underline="never"
              >
                <Badge
                  {...(question.answered
                    ? { variant: 'light', color: badgeColor.done }
                    : countBadge)}
                  maw={220}
                  style={{ cursor: 'pointer' }}
                >
                  {question.title}
                </Badge>
              </Anchor>
            )
          })}
        </Group>
      </Stack>
    </Card>
  )
}
