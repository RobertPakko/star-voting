import { Badge, Group } from '@mantine/core'
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
 * The wording is deliberately not symmetrical across the three. Respondents
 * are shown or hidden -- hiding them lists nobody at all, which is not the
 * same as listing them anonymously -- while ballots are published or
 * private. An anonymous ballot is the two tags together: respondents hidden,
 * ballots published. That combination is exactly what the ballot notice
 * spells out in words on the form itself.
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
      <Badge color="grape" variant="light">
        {mode === 'open' ? 'Open link' : 'Invite only'}
      </Badge>
      <Badge color="blue" variant="light">
        {showVoters ? 'Respondents shown' : 'Respondents hidden'}
      </Badge>
      <Badge color="teal" variant="light">
        {showBallots ? 'Ballots published' : 'Ballots private'}
      </Badge>
      {closed && (
        <Badge color="gray" variant="light">
          Closed
        </Badge>
      )}
    </Group>
  )
}
