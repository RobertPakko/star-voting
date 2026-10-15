import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Box, Button, Divider, Group, Modal, SegmentedControl, Stack, Text } from '@mantine/core'
import { EyeIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react'
import type { ScheduleEventData, ScheduleViewLevel } from '@mantine/schedule'
import { BallotFrame, type BallotScore } from './BallotFrame'
import { PaintCalendar } from './PaintCalendar'
import {
  axisFor,
  boundsOf,
  daysOf,
  describeLength,
  describeOffset,
  formatDay,
  isDaily,
  meetingMinutes,
  paintingFromScores,
  paintingRuns,
  runBounds,
  scoresFromPainting,
  formatTimeRange,
  type GranuleKey,
  type ScheduleDay,
} from '../lib/schedule'
import { NameList } from './NameList'
import {
  clearBallotDraft,
  readBallotDraft,
  useSaveBallotDraft,
  type DraftScope,
} from '../lib/ballotDraft'
import { use24HourTime } from '../lib/clock'
import { RATINGS, colorFor, inkFor, swatchFor } from '../lib/ratings'
import { offsetName } from '../lib/timezones'
import type { PollOption, PollSchedule } from '../lib/types'

/**
 * The ballot for a poll that finds a time: a calendar somebody paints.
 *
 * A voter never sees an option here, and that is the point. They mark when
 * they are free, at whatever rating; this flattens the painting into a score
 * per window on the way out and inflates the scores back into a painting on
 * the way in. Both directions are `lib/schedule.ts`, which is where the rules
 * are written down and where they are tested. The gesture itself is
 * `PaintCalendar`, which the create form paints too.
 *
 * **The grid is the poll's, not the reader's.** Every time on screen is wall
 * clock in the offset the creator declared, and no `Date` built from a voter's
 * own clock is ever compared against it -- see `lib/schedule.ts`. A voter in
 * Berlin and a voter in Denver paint the same grid with the same labels, which
 * is the whole of what "one timezone per poll" buys, and why the offset is
 * written above the calendar rather than silently converted away. The one
 * thing the reader's own zone is used for is the sentence saying how far from
 * it they are, which moves nothing.
 *
 * **What the poll is asking about is read off its own options.** There is no
 * stored list of days and no stored pair of times per day: `boundsOf` is the
 * cells the windows cover, and those are exactly the cells worth painting,
 * because painting anywhere else could not move any option's score.
 *
 * `useBallotOrder` does not apply. It shuffles the option list per browser
 * because position on a list is worth points; a calendar is scanned rather
 * than read top to bottom, and its order is chronological and load-bearing --
 * shuffling it would produce a week with Thursday in the middle. That is a
 * deliberate exception to the rule that file argues for, and the only one.
 */

export function TimeBallotCard({
  options,
  schedule,
  initial,
  draft,
  nameField,
  questionStrip,
  note,
  beforeSubmit,
  onSubmit,
  onVoted,
  onCancel,
}: {
  /** The windows, as ordinary options: each one's name is its start time. */
  options: PollOption[]
  schedule: PollSchedule
  /** The scores already on this voter's ballot; absent when casting a new one. */
  initial?: Record<string, number>
  /**
   * Where this ballot's unsent painting is kept; see lib/ballotDraft.ts. Only
   * on a first ballot, as on the list.
   */
  draft?: DraftScope
  nameField?: ReactNode
  questionStrip?: ReactNode
  note: ReactNode
  beforeSubmit?: () => boolean
  onSubmit: (scores: BallotScore[]) => Promise<void>
  onVoted: () => void
  onCancel?: () => void
}) {
  const h24 = use24HourTime()
  const windows = useMemo(() => options.map((option) => option.name), [options])
  const bounds = useMemo(() => boundsOf(windows, schedule), [windows, schedule])
  const days = useMemo(() => daysOf(bounds), [bounds])

  const drafting = initial === undefined ? draft : undefined
  const [painting, setPainting] = useState<Record<GranuleKey, number>>(() => {
    if (!initial) {
      // The painting itself is what is kept rather than the scores it makes,
      // because scores read back into a painting blur (see `paintingFromScores`)
      // and an unsent ballot should come back exactly as it was left. Only
      // cells the poll still asks about: anywhere else moves no score.
      const saved = drafting && readBallotDraft(drafting)
      if (!saved) return {}
      const restored: Record<GranuleKey, number> = {}
      for (const [key, value] of Object.entries(saved)) {
        if (value > 0 && bounds.has(key)) restored[key] = value
      }
      return restored
    }
    // `initial` is keyed by option id and the derivation works in window
    // starts, because a window start is the only thing both sides agree on.
    const byName: Record<string, number> = {}
    for (const option of options) byName[option.name] = initial[option.id] ?? 0
    return paintingFromScores(windows, byName, schedule)
  })

  useSaveBallotDraft(drafting, painting)

  const [rating, setRating] = useState('5')

  const scores = useMemo(
    () => scoresFromPainting(windows, painting, schedule),
    [windows, painting, schedule],
  )

  /** Write one rating over a set of cells, or rub them out when it is 0. */
  function apply(keys: GranuleKey[], value: number) {
    if (keys.length === 0) return
    setPainting((prev) => {
      const next = { ...prev }
      for (const key of keys) {
        // A 0 is stored as an absence rather than as a zero, so that the two
        // ways of saying "not then" -- painting it grey and never touching it
        // -- are one state rather than two that look alike.
        if (value === 0) delete next[key]
        else next[key] = value
      }
      return next
    })
  }

  /**
   * The poll's days this voter has had on screen.
   *
   * A poll can run across several weeks or months, the calendar opens on the
   * first of them, and nothing about a week grid says there is a second week
   * behind the arrow. A voter who paints the week they were shown and presses
   * Submit has said "can't make it" to every day they never saw -- an untouched
   * day is a 0 -- which is an answer they did not give. So the calendar
   * reports each range it draws (`onShowRange`), and a submit with days
   * still unseen asks first.
   *
   * "Seen" is the range on screen, not the columns a phone happens to have
   * scrolled into view: it is a glance that is being asked about, not a
   * reading.
   */
  const [seen, setSeen] = useState<ReadonlySet<ScheduleDay>>(() => new Set())
  const showRange = useCallback(
    (from: ScheduleDay, to: ScheduleDay) => {
      setSeen((prev) => {
        const added = days.filter((day) => day >= from && day <= to && !prev.has(day))
        return added.length === 0 ? prev : new Set([...prev, ...added])
      })
    },
    [days],
  )
  const unseen = days.filter((day) => !seen.has(day))

  // The pending submit, held while the warning is up: answering it is what
  // lets BallotFrame carry on or stand down. See `confirmSubmit`.
  const [pending, setPending] = useState<((go: boolean) => void) | null>(null)
  const [reveal, setReveal] = useState<{ day: ScheduleDay } | null>(null)

  /**
   * Only on a first ballot. A revision starts from the ballot already cast,
   * every day of it filled in from the scores, so a day left untouched there
   * is a day the voter answered last time rather than one they never saw.
   */
  function confirmSubmit(): Promise<boolean> {
    if (initial !== undefined || unseen.length === 0) return Promise.resolve(true)
    return new Promise((resolve) => setPending(() => resolve))
  }

  function answer(go: boolean) {
    pending?.(go)
    setPending(null)
  }

  function collect(): BallotScore[] {
    return options.map((option) => ({
      candidate_id: option.id,
      score: scores[option.name] ?? 0,
    }))
  }

  const daily = isDaily(schedule)
  /**
   * What the poll's offset is called, on the poll's own dates.
   *
   * `UTC-07:00` is an exact answer to a question nobody asked in those words:
   * a voter knows they are in California, not that they are on -07:00, and the
   * line above the calendar is the one place the poll says where it is being
   * held. So the name goes beside the number -- the number first, because it is
   * what the poll *is* and the name is the caption.
   *
   * Worked out from the first day the poll asks about rather than from today,
   * which is what lets an offset have one name at all: `-07:00` is Pacific
   * Time in July and Mountain Time in January. Nothing here reads the voter's
   * own zone, so every voter is told the same name for the same poll.
   */
  const zone = useMemo(
    () => (days[0] ? offsetName(schedule.timezone, days[0]) : null),
    [schedule.timezone, days],
  )

  /**
   * The painting as events, per view.
   *
   * The two time grids get a background wash: one block per run of cells at
   * one rating, behind the hours they cover.
   *
   * **The month gets an ordinary event per block**, which is the default thing
   * a month cell holds and reads as what it is -- a day with two marked
   * stretches shows two chips saying `09:00–11:00` and `14:00–17:00`. It used
   * to get one synthesised line per day instead, saying `Whole day` or `4h in
   * 2 blocks`; both of those are a summary of an answer rather than the
   * answer, and "whole day" was usually a lie, since the poll is rarely asking
   * about the small hours. A poll answered in whole days has no hours to name,
   * so its chips carry the rating instead -- which on that ballot is all a day
   * has to say.
   */
  function buildEvents(view: ScheduleViewLevel): ScheduleEventData[] {
    return paintingRuns(painting, schedule).map((run) => ({
      id: `${run.day} ${run.from}`,
      title:
        view !== 'month' ? '' : daily ? ratingTitle(run.value) : timeTitle(run.from, run.to, h24),
      ...runBounds(run),
      color: colorFor(run.value),
      display: view === 'month' ? 'default' : 'background',
      payload: { ink: inkFor(run.value) },
    }))
  }

  return (
    <BallotFrame
      revising={initial !== undefined}
      nameField={nameField}
      questionStrip={questionStrip}
      note={note}
      beforeSubmit={beforeSubmit}
      confirmSubmit={confirmSubmit}
      collect={collect}
      onSubmit={onSubmit}
      onVoted={() => {
        if (drafting) clearBallotDraft(drafting)
        onVoted()
      }}
      onCancel={onCancel}
      // Fetched when it is drawn rather than bundled with the ballot, so it
      // arrives after the page's own entrance has finished and has to make one
      // of its own; see BallotFrame's `arriving`.
      arriving
    >
      <Stack gap="xs">
        <Text size="sm">
          Mark the calendar with your availability. 5 is the highest preference while 0 is the
          lowest.
        </Text>
        <Divider />
        <Group gap="sm" wrap="wrap" align="center" justify="space-between">
          <Group gap={6} wrap="wrap" justify="space-between">
            <Text size="xs" c="dimmed">
              All times are {describeOffset(schedule.timezone, zone)}
              {days.length > 0 && ' · '}
            </Text>
            <Text size="xs" c="dimmed">
              {/* The one place a voter is told how long the meeting is: every
                  option is a window of that length, and a calendar of rated
                  hours says nothing about it on its own. */}
              {days.length > 0 &&
                `${formatDay(days[0])} to ${formatDay(days[days.length - 1])} (${describeLength(meetingMinutes(schedule))})`}
            </Text>
          </Group>
          <SegmentedControl
            size="xs"
            value={rating}
            onChange={setRating}
            data={RATINGS.map((level) => ({
              value: level.value,
              label: (
                <Group gap={6} wrap="nowrap" justify="center">
                  <Box
                    w={10}
                    h={10}
                    style={{
                      borderRadius: 2,
                      background: swatchFor(Number(level.value)),
                    }}
                  />
                  <span>{level.label}</span>
                </Group>
              ),
            }))}
          />
        </Group>

        <PaintCalendar
          schedule={schedule}
          bounds={bounds}
          // The poll's own axis, widened to hold every window on the ballot.
          // `window` is the axis the poll was *created* with, and the list has
          // been able to grow past it ever since a group could add to it -- a
          // window outside it would otherwise be a row the grid does not draw,
          // which is an option nobody can score and nobody can see. See
          // `axisFor`.
          axis={axisFor(schedule.window, bounds, schedule)}
          painting={painting}
          brush={Number(rating)}
          onPaint={apply}
          buildEvents={buildEvents}
          // The ballot is the one screen whose bounds are the whole of the
          // answer, so it is the one screen that can say where the calendar
          // stops. That is not true of the two screens that paint what a poll
          // asks about.
          confine
          onShowRange={showRange}
          reveal={reveal}
        />
        <Divider />
      </Stack>

      <Modal
        opened={pending !== null}
        onClose={() => answer(false)}
        title="You haven't looked at every day yet"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            This poll also asks about{' '}
            <NameList max={3} names={unseen.map((day) => ({ id: day, name: formatDay(day) }))} />
            which you haven't looked at.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button
              variant="default"
              leftSection={<EyeIcon size={16} aria-hidden />}
              onClick={() => {
                answer(false)
                setReveal({ day: unseen[0] })
              }}
            >
              Show me
            </Button>
            <Button
              onClick={() => answer(true)}
              leftSection={<PaperPlaneTiltIcon size={16} aria-hidden />}
            >
              Submit anyway
            </Button>
          </Group>
        </Stack>
      </Modal>
    </BallotFrame>
  )
}

/** `9–11am`, which is what a month cell says about one marked stretch. */
function timeTitle(from: number, to: number, h24: boolean): string {
  return formatTimeRange(from, to, h24)
}

/** And what one says on a poll answered in whole days, which has no hours. */
function ratingTitle(rating: number): string {
  return rating === 0 ? "Can't" : `Rated ${rating}`
}
