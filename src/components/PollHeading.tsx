import { Group, Stack, Text, Title } from '@mantine/core'
import { PollStateBadge, PollTags } from './PollTags'
import type { Turnout } from './PollTags'
import type { PollMode } from '../lib/types'

/**
 * A poll's heading, in one shape wherever a poll is read: the card on the
 * list, the poll's own page, and the public voting page.
 *
 * Four things, always in this order:
 *
 *  1. the title, with where the poll has got to in a badge beside it;
 *  2. the poll's description, when it has one;
 *  3. who created it;
 *  4. the four badges saying what kind of poll it is.
 *
 * The order is not a preference. A description is the creator's own words
 * about the poll and belongs with the title it extends, above the row of
 * app-written badges rather than stranded under it; and the creator's name
 * is the last thing about the poll itself before the row that describes its
 * terms. Two screens describing one poll differently is two things to learn
 * about a poll instead of one, which is the whole reason this is one
 * component and not three copies that drift.
 *
 * `compact` is the list card, where the heading sits inside a link among
 * nine others and a page title would shout; it is the same five things at
 * smaller sizes, not a different heading.
 */
export function PollHeading({
  title,
  description,
  createdBy,
  mode,
  showVoters,
  showBallots,
  turnout,
  state,
  compact = false,
}: {
  title: string
  description: string | null
  /**
   * Who created the poll: `'you'`, an email address, or `null` for a reader
   * who is not to be told. The public voting page is the last of those, and
   * the one part of this heading it leaves out: every address the app shows
   * is shown to somebody already in the poll it belongs to, and a share link
   * reaches whoever it was forwarded to.
   */
  createdBy: 'you' | string | null
  mode: PollMode
  showVoters: boolean
  showBallots: boolean
  turnout?: Turnout
  state: {
    soliciting: boolean
    resultsAvailable: boolean
    closed: boolean
    /** Absent where the page cannot ask; see PollStateBadge. */
    winner?: string | null
    /** An answer is coming: the badge waits rather than flickering. */
    awaitingWinner?: boolean
  }
  compact?: boolean
}) {
  return (
    <Stack gap={compact ? 4 : 8}>
      {/* The badge sits beside the title while both fit, and drops onto its
          own line under it when they don't. It used to be pinned there
          (`wrap="nowrap"`), which on a phone left a winner's name holding
          220px of a 330px card and the title wrapping one or two characters
          at a time down the side of it — the title was technically the side
          that gave, and what it gave was legibility. Letting the row wrap
          means the narrow case is a title across the full width with its
          badge below, which is the same two things in the same order, and the
          badge keeps its own width rather than being squeezed in turn. See
          PollStateBadge. */}
      <Group justify="space-between" wrap="wrap" align="flex-start" gap="sm">
        {/* `minWidth` lets the title wrap past its longest word, which one
            with no spaces in it otherwise would not. */}
        {compact ? (
          <Text
            fw={600}
            c="var(--mantine-color-text)"
            style={{ minWidth: 0, wordBreak: 'break-word' }}
          >
            {title}
          </Text>
        ) : (
          <Title order={2} style={{ minWidth: 0, wordBreak: 'break-word' }}>
            {title}
          </Title>
        )}
        <PollStateBadge
          soliciting={state.soliciting}
          resultsAvailable={state.resultsAvailable}
          closed={state.closed}
          winner={state.winner}
          awaitingWinner={state.awaitingWinner}
        />
      </Group>

      {description && (
        <Text size={compact ? 'sm' : undefined} c="dimmed">
          {description}
        </Text>
      )}

      {createdBy && (
        <Text size="xs" c="dimmed">
          {createdBy === 'you' ? 'Created by you' : `Created by ${createdBy}`}
        </Text>
      )}

      {/* The terms of the poll, at the top, whichever way each one is set:
          people arrive here from a link with no other context, and these are
          the only place a voter is told what happens to their ballot. */}
      <div style={compact ? { marginTop: 4 } : undefined}>
        <PollTags mode={mode} showVoters={showVoters} showBallots={showBallots} turnout={turnout} />
      </div>
    </Stack>
  )
}
