import { Badge, Group } from '@mantine/core'
import { badgeColor } from '../lib/badgeColors'
import type { PollMode } from '../lib/types'

/**
 * The three settings a poll is frozen with, always all three, always in the
 * same order and the same words.
 *
 * Always-present matters more than it sounds: when a tag only appeared for
 * one of its two states, its absence had to be read as the other state, and
 * "no tag" is not something anyone reads. Showing both states of all three
 * means the terms of a poll can be taken in at a glance and compared between
 * polls.
 *
 * Every state carries its own colour rather than one colour per setting —
 * see `src/lib/badgeColors.ts` for why, and for the whole palette these are
 * picked from.
 *
 * The wording is deliberately not symmetrical across the three. Respondents
 * are shown or hidden -- hiding them lists nobody at all, which is not the
 * same as listing them anonymously -- while ballots are published or
 * private. An anonymous ballot is the two tags together: respondents hidden,
 * ballots published.
 *
 * These tags are also the only place a voter is told what happens to their
 * ballot, so every page carrying a ballot puts them above it.
 */
export function PollTags({
  mode,
  showVoters,
  showBallots,
  closed = false,
}: {
  mode: PollMode
  showVoters: boolean
  showBallots: boolean
  /** Not a setting -- a state -- so it is greyed and always sits last. */
  closed?: boolean
}) {
  return (
    <Group gap="xs">
      <Badge color={mode === 'open' ? badgeColor.openLink : badgeColor.inviteOnly} variant="light">
        {mode === 'open' ? 'Open link' : 'Invite only'}
      </Badge>
      <Badge
        color={showVoters ? badgeColor.respondentsShown : badgeColor.respondentsHidden}
        variant="light"
      >
        {showVoters ? 'Respondents shown' : 'Respondents hidden'}
      </Badge>
      <Badge
        color={showBallots ? badgeColor.ballotsPublished : badgeColor.ballotsPrivate}
        variant="light"
      >
        {showBallots ? 'Ballots published' : 'Ballots private'}
      </Badge>
      {closed && (
        <Badge color={badgeColor.closed} variant="light">
          Closed
        </Badge>
      )}
    </Group>
  )
}
