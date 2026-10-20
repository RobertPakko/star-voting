import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Group } from '@mantine/core'
import { badgeColor, countBadge } from '../lib/badgeColors'
import type { PollMode } from '../lib/types'
import classes from './PollTags.module.css'
import { announce } from '../lib/announce'

/**
 * The row of four badges describing a poll, identical on every screen: mode,
 * respondents, ballots (in the order CreatePoll asks), then the count. Both
 * states of each setting are always shown, since an absent tag reads as
 * nothing. Every string here is decided here; this is the only place a voter
 * is told what happens to their ballot. See "Poll settings are frozen at
 * creation" in AGENTS.md.
 */
export function PollTags({
  mode,
  showVoters,
  showBallots,
  turnout,
  className,
  announceChanges = false,
}: {
  mode: PollMode
  showVoters: boolean
  showBallots: boolean
  /** For a caller that has to keep room at the end of the row; see PollList. */
  className?: string
  /** Omit (not zero) where the count isn't known yet. */
  turnout?: Turnout
  /** Announce count changes to screen readers -- the poll's own page only. */
  announceChanges?: boolean
}) {
  const label = turnout ? turnoutLabel(turnout) : null
  const { changes, was, settled } = useChangeCount(label)

  // "of" for the slash, which a screen reader would read literally.
  useStateAnnouncement(announceChanges && label ? label.replace(/^(\d+)\/(\d+)/, '$1 of $2') : null)

  return (
    <Group gap="xs" className={className}>
      <Badge color={mode === 'open' ? badgeColor.openLink : badgeColor.inviteOnly} variant="light">
        {mode === 'open' ? 'Open link' : 'Invite only'}
      </Badge>
      <Badge
        color={showVoters ? badgeColor.respondentsShown : badgeColor.respondentsHidden}
        variant="light"
      >
        {showVoters ? 'Voters shown' : 'Voters hidden'}
      </Badge>
      <Badge
        color={showBallots ? badgeColor.ballotsPublished : badgeColor.ballotsPrivate}
        variant="light"
      >
        {showBallots ? 'Ballots published' : 'Ballots private'}
      </Badge>
      {turnout && (
        <Badge
          {...countBadge}
          // Remounted per change so the highlight animation restarts.
          key={changes}
          className={changes > 0 ? classes.bumped : undefined}
        >
          {/* The old count rolls up and out as the new one rolls in. */}
          {changes > 0 && was ? (
            <span className={classes.roll}>
              <span className={classes.rollOut} aria-hidden onAnimationEnd={settled}>
                {was}
              </span>
              <span className={classes.rollIn}>{label}</span>
            </span>
          ) : (
            label
          )}
        </Badge>
      )}
    </Group>
  )
}

/**
 * How many times `value` has changed since first render (the first value
 * isn't news), and the previous value for the roll. `settled` drops it once
 * the roll ends -- otherwise copying the badge gave "0 votes1 vote". Computed
 * during render so the first frame of new text is already rolling.
 */
function useChangeCount(value: string | null): {
  changes: number
  was: string | null
  settled: () => void
} {
  const [state, setState] = useState<{ value: string | null; changes: number; was: string | null }>(
    { value, changes: 0, was: null },
  )
  if (state.value !== value) setState({ value, changes: state.changes + 1, was: state.value })
  const settled = useCallback(() => setState((held) => ({ ...held, was: null })), [])
  return { changes: state.changes, was: state.was, settled }
}

/** What the count badge counts. */
export interface Turnout {
  soliciting: boolean
  mode: PollMode
  votedCount: number
  invitedCount: number
  /** Confirmations, shown while collecting. Undefined only against an older database. */
  confirmedCount?: number
  /** Fallback for a missing `confirmedCount`. */
  optionCount: number
  /** Above one, the badge shows the question count instead of a turnout. */
  questionCount?: number
}

/**
 * The count: questions on a multi-question poll (their turnouts differ),
 * confirmations while collecting, votes otherwise. Open polls have no invite
 * list, so no denominator. Kept after close, as the turnout the result was
 * reached on.
 */
function turnoutLabel({
  soliciting,
  mode,
  votedCount,
  invitedCount,
  confirmedCount,
  optionCount,
  questionCount,
}: Turnout): string {
  if (questionCount !== undefined && questionCount > 1) {
    return `${questionCount} questions`
  }
  if (soliciting) {
    if (confirmedCount === undefined) {
      return `${optionCount} ${optionCount === 1 ? 'option' : 'options'}`
    }
    if (mode === 'open') return `${confirmedCount} confirmed`
    return `${confirmedCount}/${invitedCount} confirmed`
  }
  if (mode === 'open') {
    return `${votedCount} ${votedCount === 1 ? 'vote' : 'votes'}`
  }
  return `${votedCount}/${invitedCount} votes`
}

/**
 * Where the poll has got to, beside its title: collecting, in progress,
 * closed, or finished -- naming the winner, *Tie* for no winner, or *Results
 * ready* when there is no single name to give (a multi-question poll, or an
 * answer this page wasn't told). *Results ready* must never read as *Tie*.
 */
export function PollStateBadge({
  soliciting,
  resultsAvailable,
  closed,
  winner,
  inGroup = false,
  announceChanges = false,
}: {
  soliciting: boolean
  resultsAvailable: boolean
  closed: boolean
  /** The winner; null for no winner; undefined when not told. */
  winner?: string | null
  /**
   * A multi-question poll, which names no winner. Decided here rather than by
   * callers, since a group's list row is its first question and would
   * otherwise carry that question's winner.
   */
  inGroup?: boolean
  announceChanges?: boolean
}) {
  useStateAnnouncement(
    announceChanges
      ? stateSentence({ soliciting, resultsAvailable, closed, winner, inGroup })
      : null,
  )

  if (soliciting) {
    return (
      <Badge color={badgeColor.collectingOptions} variant="light" style={{ flexShrink: 0 }}>
        Collecting options
      </Badge>
    )
  }

  if (resultsAvailable) {
    if (inGroup || winner === undefined) {
      return (
        <Badge color={badgeColor.done} variant="light" style={{ flexShrink: 0 }}>
          Results ready
        </Badge>
      )
    }
    if (winner === null) {
      return (
        <Badge color={badgeColor.unsettled} variant="light" style={{ flexShrink: 0 }}>
          Tie
        </Badge>
      )
    }
    // The one badge holding the poll's own text, so the only one capped:
    // up to 40% of the heading row, ellipsised beyond. See PollHeading.
    return (
      <Badge
        color={badgeColor.done}
        variant="light"
        maw="40%"
        style={{ flexShrink: 0, flexGrow: 0 }}
        title={winner}
      >
        {winner}
      </Badge>
    )
  }

  if (closed) {
    return (
      <Badge color={badgeColor.closed} variant="light" style={{ flexShrink: 0 }}>
        Closed
      </Badge>
    )
  }

  return (
    <Badge color={badgeColor.outstanding} variant="light" style={{ flexShrink: 0 }}>
      In progress
    </Badge>
  )
}

/** The badge's state as a sentence for a screen reader. */
function stateSentence({
  soliciting,
  resultsAvailable,
  closed,
  winner,
  inGroup,
}: {
  soliciting: boolean
  resultsAvailable: boolean
  closed: boolean
  winner?: string | null
  inGroup: boolean
}): string {
  if (soliciting) return 'The poll is collecting options'
  if (resultsAvailable) {
    if (!inGroup && winner) return `The results are in: ${winner} won`
    if (!inGroup && winner === null) return 'The results are in: a tie, with no winner'
    return 'The results are in'
  }
  if (closed) return 'The poll has closed'
  return 'The poll is open for voting'
}

/**
 * Announce a sentence when it changes -- not on first render, and not to or
 * from null (still loading, or no longer drawn).
 */
function useStateAnnouncement(sentence: string | null) {
  const previous = useRef(sentence)
  useEffect(() => {
    if (sentence === previous.current) return
    const was = previous.current
    previous.current = sentence
    if (was !== null && sentence !== null) announce(sentence)
  }, [sentence])
}
