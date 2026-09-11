import { useMemo, useState, type ReactNode } from 'react'
import { Box, Button, Group, SegmentedControl, Stack, Text } from '@mantine/core'
import type { ScheduleEventData, ScheduleViewLevel } from '@mantine/schedule'
import { BallotFrame, type BallotScore } from './BallotFrame'
import { PaintCalendar } from './PaintCalendar'
import {
  boundsOf,
  daysOf,
  describeLength,
  describeOffset,
  formatDay,
  isDaily,
  meetingMinutes,
  offsetFromViewer,
  paintingFromScores,
  paintingRuns,
  runBounds,
  scoresFromPainting,
  toTimeOfDay,
  type GranuleKey,
} from '../lib/schedule'
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

/**
 * The six ratings, and the colours they are painted in.
 *
 * **A ramp of hue, not of shade.** These were six blues from `blue.2` to
 * `blue.9`, which is a scale you can order but cannot read: a 2 and a 3 beside
 * each other on a week grid are two rectangles of nearly the same colour, and
 * the question a painted calendar is answering is "what did I put here". Red
 * through green is the ordering everybody already knows for "bad to good", and
 * the shades still darken along it -- so the ramp survives being seen by
 * somebody who cannot tell the red end from the green one, and does not depend
 * on that for its first reading.
 *
 * `ink` is chosen here rather than left to the calendar. A month chip takes
 * its text colour from Mantine's variant resolver, and at the dark end of this
 * ramp that comes back close enough to the background to be unreadable --
 * `green.9` on `green.9`, which is a label everywhere except on screen. Picked
 * against the six swatches rather than computed, because there are six of them
 * and they do not change.
 */
const RATINGS = [
  { value: '0', label: "Can't", color: 'gray.5', ink: 'black' },
  { value: '1', label: '1', color: 'red.4', ink: 'black' },
  { value: '2', label: '2', color: 'orange.5', ink: 'black' },
  { value: '3', label: '3', color: 'yellow.5', ink: 'black' },
  { value: '4', label: '4', color: 'teal.6', ink: 'white' },
  { value: '5', label: '5', color: 'green.9', ink: 'white' },
]

function inkFor(rating: number): string {
  return `var(--mantine-color-${RATINGS[rating]?.ink ?? 'black'})`
}

function colorFor(rating: number): string {
  return RATINGS[rating]?.color ?? 'gray.5'
}

export function TimeBallotCard({
  options,
  schedule,
  initial,
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
  nameField?: ReactNode
  questionStrip?: ReactNode
  note: ReactNode
  beforeSubmit?: () => boolean
  onSubmit: (scores: BallotScore[]) => Promise<void>
  onVoted: () => void
  onCancel?: () => void
}) {
  const windows = useMemo(() => options.map((option) => option.name), [options])
  const bounds = useMemo(() => boundsOf(windows, schedule), [windows, schedule])
  const days = useMemo(() => daysOf(bounds), [bounds])

  const [painting, setPainting] = useState<Record<GranuleKey, number>>(() => {
    if (!initial) return {}
    // `initial` is keyed by option id and the derivation works in window
    // starts, because a window start is the only thing both sides agree on.
    const byName: Record<string, number> = {}
    for (const option of options) byName[option.name] = initial[option.id] ?? 0
    return paintingFromScores(windows, byName, schedule)
  })

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

  function collect(): BallotScore[] {
    return options.map((option) => ({
      candidate_id: option.id,
      score: scores[option.name] ?? 0,
    }))
  }

  const length = meetingMinutes(schedule)
  const daily = isDaily(schedule)
  const away = offsetFromViewer(schedule, days[0])
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
      title: view !== 'month' ? '' : daily ? ratingTitle(run.value) : timeTitle(run.from, run.to),
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
      collect={collect}
      onSubmit={onSubmit}
      onVoted={onVoted}
      onCancel={onCancel}
      // Fetched when it is drawn rather than bundled with the ballot, so it
      // arrives after the page's own entrance has finished and has to make one
      // of its own; see BallotFrame's `arriving`.
      arriving
    >
      <Stack gap="xs">
        <Text size="sm">
          Mark when you could meet for {describeLength(length)}.{' '}
          {daily ? (
            <>Click a day to mark it, or drag across several.</>
          ) : (
            <>
              Drag across the calendar to paint, click a day&apos;s heading — or a day in the month
              view — to fill the whole of it.
            </>
          )}{' '}
          Use <b>Can&apos;t</b> to rub something out.
        </Text>

        <Group gap="sm" wrap="wrap" align="center">
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
                      background:
                        level.value === '0'
                          ? 'var(--mantine-color-default-border)'
                          : `var(--mantine-color-${level.color.replace('.', '-')})`,
                    }}
                  />
                  <span>{level.label}</span>
                </Group>
              ),
            }))}
          />
          {/* What the ratings are worth is worth saying, because a window is
              scored by averaging what is under it: a time somebody can make
              most of is a 4, not the 0 the old rule gave it, and only a time
              they can make all of is a 5. */}
          <Text size="xs" c="dimmed">
            5 is the best time for you; 1 is the worst you would still accept. Each possible meeting
            time scores the average of what you marked across it.
          </Text>
        </Group>

        {/* The zone is stated rather than converted, because converting it is
            the one thing this poll promised not to do: everybody is looking at
            the same grid, and a voter elsewhere needs to be told which one --
            and then how many hours from the clock on their own wall, which is
            the part they were going to work out anyway. */}
        <Group gap={6} wrap="wrap" justify="space-between">
          <Text size="xs" c="dimmed">
            All times are {describeOffset(schedule.timezone, zone)}
            {away && ` · ${away}`}
            {days.length > 0 && ` · ${formatDay(days[0])} to ${formatDay(days[days.length - 1])}`}
          </Text>
          {/* One press for the answer most people are giving. *Clear
              everything* used to live here, which is the same gesture with one
              value hard-coded into it -- so it is this, with the brush deciding
              which value: `5` for somebody free throughout, and `Can't` for
              somebody starting again. */}
          <Button
            variant="default"
            size="compact-xs"
            onClick={() => apply([...bounds], Number(rating))}
          >
            Apply {RATINGS[Number(rating)].label.toLowerCase()} to every time
          </Button>
        </Group>

        <PaintCalendar
          schedule={schedule}
          bounds={bounds}
          axis={schedule.window}
          painting={painting}
          brush={Number(rating)}
          onPaint={apply}
          buildEvents={buildEvents}
        />
      </Stack>
    </BallotFrame>
  )
}

/** `09:00–11:00`, which is what a month cell says about one marked stretch. */
function timeTitle(from: number, to: number): string {
  return `${toTimeOfDay(from)}–${toTimeOfDay(to)}`
}

/** And what one says on a poll answered in whole days, which has no hours. */
function ratingTitle(rating: number): string {
  return rating === 0 ? "Can't" : `Rated ${rating}`
}
