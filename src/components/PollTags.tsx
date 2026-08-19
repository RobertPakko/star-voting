import { Badge, Group } from '@mantine/core'
import { badgeColor } from '../lib/badgeColors'
import type { PollMode } from '../lib/types'

/**
 * The four settings a poll is frozen with, always all four, always in the
 * same order and the same words — the same order the create form asks them
 * in.
 *
 * Always-present matters more than it sounds: when a tag only appeared for
 * one of its two states, its absence had to be read as the other state, and
 * "no tag" is not something anyone reads. Showing both states of all four
 * means the terms of a poll can be taken in at a glance and compared between
 * polls.
 *
 * Every state carries its own colour rather than one colour per setting —
 * see `src/lib/badgeColors.ts` for why, and for the whole palette these are
 * picked from.
 *
 * The wording is deliberately not symmetrical across the four. Respondents
 * are shown or hidden -- hiding them lists nobody at all, which is not the
 * same as listing them anonymously -- while ballots are published or
 * private. An anonymous ballot is the two tags together: respondents hidden,
 * ballots published. Options say where they came from rather than whether
 * they are open, because by the time most people read the tag the list has
 * been settled and only its origin is still true.
 *
 * These tags are also the only place a voter is told what happens to their
 * ballot, so every page carrying a ballot puts them above it.
 *
 * `soliciting` and `closed` are states rather than settings: neutral instead
 * of coloured, and always after the four. A poll can only be in one of them
 * — collecting happens before the first vote, closing after the last.
 */
export function PollTags({
  mode,
  showVoters,
  showBallots,
  solicitOptions,
  soliciting = false,
  closed = false,
}: {
  mode: PollMode
  showVoters: boolean
  showBallots: boolean
  /** Where the options came from, which stays true long after the poll ends. */
  solicitOptions: boolean
  /** Not a setting -- a state -- so it is neutral and sits after the four. */
  soliciting?: boolean
  /** Not a setting either, and always last. */
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
      <Badge
        color={solicitOptions ? badgeColor.optionsFromRespondents : badgeColor.optionsFromCreator}
        variant="light"
      >
        {solicitOptions ? 'Options from respondents' : 'Options from creator'}
      </Badge>
      {soliciting && (
        <Badge color={badgeColor.collectingOptions} variant="light">
          Collecting options
        </Badge>
      )}
      {closed && (
        <Badge color={badgeColor.closed} variant="light">
          Closed
        </Badge>
      )}
    </Group>
  )
}
