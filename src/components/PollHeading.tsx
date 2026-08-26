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
    <Stack gap="xs">
      {/* The title and the badge share one row, sixty/forty, and neither is
          allowed to take the other's half.

          Both earlier attempts came apart on a phone. Left free to give, the
          title took min-content and wrapped one or two characters at a time
          down the side of a badge holding 220px of a 330px card; pinned so
          the badge could not shrink, the row had to wrap and the badge
          dropped onto a line of its own, which is a lot of vertical space for
          a word or two and reads as a second thing rather than as part of the
          heading.

          So the split is stated instead of negotiated. The title's *basis* is
          60% and the badge's ceiling is 40%, and the slack goes to whoever
          needs it: the badge takes only as much as its text — *In progress*
          asks for a fifth of the row, not two fifths — and the title grows
          into everything left over, so sixty is a floor rather than a
          serving. Past the ceiling it is the title that gives, wrapping
          inside its own share, because a wrapped title is still readable and
          an elected option ellipsised to two letters is not an answer at
          all. */}
      <Stack gap={0}>
        <Group align="flex-start" gap="sm" wrap="nowrap">
          {/* `minWidth: 0` is what lets a flex item shrink below its longest
            word at all; without it a title with no spaces in it would push
            the row wider than the card. */}
          {compact ? (
            <Text
              fw={600}
              c="var(--mantine-color-text)"
              style={{ flex: '1 1 60%', minWidth: 0, wordBreak: 'break-word' }}
            >
              {title}
            </Text>
          ) : (
            <Title order={2} style={{ flex: '1 1 60%', minWidth: 0, wordBreak: 'break-word' }}>
              {title}
            </Title>
          )}
          {/* The forty is the badge's own ceiling rather than a box around it;
            see PollStateBadge, where only the badge carrying a poll's own
            text takes it. */}
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
      </Stack>

      <PollTags mode={mode} showVoters={showVoters} showBallots={showBallots} turnout={turnout} />
    </Stack>
  )
}
