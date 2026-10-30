import { useMemo, useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  Card,
  CloseButton,
  Group,
  MultiSelect,
  Stack,
  Text,
  useMantineTheme,
} from '@mantine/core'
import { UsersThreeIcon } from '@phosphor-icons/react'
import type { ScheduleEventData, ScheduleViewLevel } from '@mantine/schedule'
import { PaintCalendar } from './PaintCalendar'
import {
  averagePainting,
  axisFor,
  boundsOf,
  daysOf,
  describeOffset,
  formatDay,
  formatTimeRange,
  granuleKey,
  isDaily,
  paintingFromScores,
  paintingRuns,
  runBounds,
  type GranuleKey,
  type ScheduleDay,
} from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import { offsetName } from '../lib/timezones'
import { count } from '../lib/plural'
import { RATINGS, blendFor, colorFor, inkFor, inkOn, swatchFor } from '../lib/ratings'
import type { BallotSheet, PollSchedule } from '../lib/types'

/**
 * The results' copies of a time poll's ballots, drawn as the calendar they
 * were painted on rather than as a row per window.
 *
 * A time poll's options are windows -- a working week is over a hundred of
 * them -- and the two cards every other poll gets under its tally, a list of
 * the reader's own scores and a grid of everybody's, are a list and a grid of
 * timestamps. Both are correct and neither can be read: "when could people
 * make it" is a question about a week, and a week is a calendar.
 *
 * **Nothing new is asked for.** Each card is drawn from exactly what the card
 * it replaces was drawn from -- the reader's own scores, or the published
 * sheet -- and the calendar is put back together in the browser by the same
 * `paintingFromScores` that fills in a ballot behind *Edit vote*. So it is
 * subject to the same blur that function documents: anything shorter than the
 * meeting comes back as a step in the rating rather than a hole.
 *
 * Both are the ballot's own `PaintCalendar`, read only -- the same grid, the
 * same three views, the same colours -- so what a voter reads back is the
 * thing they painted.
 */

/**
 * One ballot, the reader's own: the calendar they painted, read back.
 */
export function ScheduleBallot({
  options,
  scores,
  schedule,
}: {
  /** The windows, as ordinary options: each one's name is its start time. */
  options: { id: string; name: string }[]
  /** Keyed by option id, as every ballot is stored. */
  scores: Record<string, number>
  schedule: PollSchedule
}) {
  const windows = useMemo(() => options.map((option) => option.name), [options])
  const painting = useMemo(() => {
    const byName: Record<string, number> = {}
    for (const option of options) byName[option.name] = scores[option.id] ?? 0
    return paintingFromScores(windows, byName, schedule)
  }, [options, windows, scores, schedule])

  return (
    <Card withBorder p="sm">
      <ReadCalendar windows={windows} schedule={schedule} painting={painting} />
    </Card>
  )
}

/**
 * Every published ballot, laid over one calendar as the average rating of
 * each cell -- and a picker for whose ballots go into that average.
 *
 * **The average is worked out here**, from the sheet the grid it replaces was
 * drawn from, so choosing a different set of people costs no request and
 * discloses nothing the sheet had not already: anybody holding the sheet can
 * add any subset of its rows up by hand, and the CSV beside the heading exists
 * so that they can. See `averagePainting` for how one cell is averaged, and
 * why a set of one is exactly that voter's own calendar.
 *
 * **Everybody is in it to begin with.** The first question this card answers
 * is the poll's -- when can the group make it -- and the picker is for the
 * second: when can these four make it, or what if Sam does not come. On a
 * sheet whose ballots are unnamed the picker still works, by ballot number,
 * because a ballot number is all the grid it replaces ever said about them.
 *
 * **A block can be opened**, to say how each of those people rated it: the
 * average says a time is good, and the breakdown says who it is bad for, which
 * is the question when the winner falls through and the group is looking for
 * the next best time. It is the same sheet again, read one block at a time.
 */
export function ScheduleBallots({
  sheet,
  schedule,
}: {
  /** The sheet as read, before any relabelling: its option names are windows. */
  sheet: BallotSheet
  schedule: PollSchedule
}) {
  const windows = useMemo(() => sheet.options.map((option) => option.name), [sheet.options])

  // One window-keyed score map per ballot, in the sheet's own order, which is
  // the order the picker lists them in.
  const byBallot = useMemo(
    () =>
      sheet.ballots.map((ballot) => {
        const byName: Record<string, number> = {}
        for (const option of sheet.options) byName[option.name] = ballot.scores[option.id] ?? 0
        return byName
      }),
    [sheet],
  )

  // By position rather than by name: two people on an open poll can type the
  // same name, and an unnamed sheet has nothing else to go on by design.
  const everyone = useMemo(() => sheet.ballots.map((_, i) => String(i)), [sheet.ballots])
  const choices = useMemo(
    () =>
      sheet.ballots.map((ballot, i) => ({
        value: String(i),
        label: sheet.voters_named && ballot.voter ? ballot.voter : `Ballot #${i + 1}`,
      })),
    [sheet],
  )
  const [chosen, setChosen] = useState<string[]>(everyone)
  const [picked, setPicked] = useState<Block | null>(null)

  // Each ballot as the calendar it was painted on, for the breakdown: the same
  // repainting the average is taken over, so a voter's row agrees with what
  // the block's colour is an average of.
  const paintings = useMemo(
    () => byBallot.map((scores) => paintingFromScores(windows, scores, schedule)),
    [windows, byBallot, schedule],
  )

  const painting = useMemo(
    () =>
      averagePainting(
        windows,
        chosen.map((i) => byBallot[Number(i)]).filter((scores) => scores !== undefined),
        schedule,
      ),
    [windows, chosen, byBallot, schedule],
  )

  const all = chosen.length === everyone.length
  const noun = sheet.voters_named ? 'voter' : 'ballot'

  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <MultiSelect
          // No visible label: the line under the field already says what it
          // is averaging. A screen reader still needs the field named.
          aria-label={sheet.voters_named ? 'Whose ballots to average' : 'Which ballots to average'}
          placeholder={chosen.length === 0 ? `Pick a ${noun}` : undefined}
          data={choices}
          value={chosen}
          onChange={setChosen}
          leftSection={<UsersThreeIcon size={16} aria-hidden />}
          comboboxProps={{ withinPortal: true }}
        />
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Text size="xs" c="dimmed" aria-live="polite">
            {chosen.length === 0
              ? 'Nobody picked.'
              : all
                ? `The average of all ${count(everyone.length, noun)}.`
                : `The average of ${chosen.length} of ${count(everyone.length, noun)}.`}
          </Text>
          {/* Both ends of the picker in one press each. Mantine's own clear
              button shows only under the pointer on a desktop, which is
              nowhere a keyboard or a phone can find it. */}
          <Group gap={4} wrap="nowrap">
            {!all && (
              <Button size="compact-xs" variant="subtle" onClick={() => setChosen(everyone)}>
                Everyone
              </Button>
            )}
            {chosen.length > 0 && (
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setChosen([])}>
                Clear
              </Button>
            )}
          </Group>
        </Group>
        <ReadCalendar
          windows={windows}
          schedule={schedule}
          painting={painting}
          average
          picked={picked}
          onPick={(block) => setPicked(sameBlock(block, picked) ? null : block)}
          onUnpick={() => setPicked(null)}
          details={
            picked && (
              <Breakdown
                block={picked}
                schedule={schedule}
                voters={chosen.map((i) => ({
                  name: choices[Number(i)]?.label ?? '',
                  painting: paintings[Number(i)] ?? {},
                }))}
                onClose={() => setPicked(null)}
              />
            )
          }
        />
        {chosen.length > 0 && (
          <Text size="xs" c="dimmed">
            Tap a block to see how each {noun} rated it.
          </Text>
        )}
      </Stack>
    </Card>
  )
}

/** One block of the averaged calendar, as drawn: a stretch of one day, in minutes. */
type Block = { day: ScheduleDay; from: number; to: number }

function sameBlock(a: Block, b: Block | null): boolean {
  return b !== null && a.day === b.day && a.from === b.from && a.to === b.to
}

/**
 * How each chosen voter rated one block, in the block's popover. A block is a stretch the *average*
 * holds level, so one voter can rate parts of it differently (two voters
 * swapping a 5 and a 3 average the same); such a voter's rating is given as
 * the range it spans rather than rounded to one number that they never gave.
 * Best first, so who cannot make it is at the foot, together.
 */
function Breakdown({
  block,
  schedule,
  voters,
  onClose,
}: {
  block: Block
  schedule: PollSchedule
  /** In the picker's order, which breaks ties in the ordering. */
  voters: { name: string; painting: Record<GranuleKey, number> }[]
  onClose: () => void
}) {
  const h24 = use24HourTime()
  const cells: GranuleKey[] = []
  for (let at = block.from; at < block.to; at += schedule.granularity) {
    cells.push(granuleKey(block.day, at))
  }

  const rows = voters
    .map((voter, order) => {
      const ratings = cells.map((key) => voter.painting[key] ?? 0)
      return {
        ...voter,
        order,
        low: Math.min(...ratings),
        high: Math.max(...ratings),
        mean: ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length,
      }
    })
    .sort((a, b) => b.mean - a.mean || b.high - a.high || a.order - b.order)
  const average = rows.reduce((sum, row) => sum + row.mean, 0) / rows.length

  const when = isDaily(schedule)
    ? formatDay(block.day)
    : `${formatTimeRange(block.from, block.to, h24)}, ${formatDay(block.day)}`

  return (
    <Stack gap={6}>
      <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
        <Text size="sm" fw={600}>
          {when}: average {average.toFixed(1)} of 5
        </Text>
        <CloseButton size="sm" aria-label="Close the breakdown" onClick={onClose} />
      </Group>
      {rows.map((row) => (
        <Group key={row.order} justify="space-between" gap="xs" wrap="nowrap">
          <Text size="sm" truncate>
            {row.name}
          </Text>
          <Group gap={6} wrap="nowrap">
            <Box
              w={10}
              h={10}
              style={{ borderRadius: 2, flexShrink: 0, background: swatchFor(row.low) }}
            />
            {row.high !== row.low && (
              <Box
                w={10}
                h={10}
                style={{ borderRadius: 2, flexShrink: 0, background: swatchFor(row.high) }}
              />
            )}
            <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {row.high === row.low ? row.low : `${row.low}\u2013${row.high}`}
            </Text>
          </Group>
        </Group>
      ))}
    </Stack>
  )
}

/**
 * The calendar both cards draw: where the poll is held, which colour is which
 * rating, and the grid itself, read only.
 */
function ReadCalendar({
  windows,
  schedule,
  painting,
  average = false,
  picked = null,
  onPick,
  onUnpick,
  details,
}: {
  windows: string[]
  schedule: PollSchedule
  painting: Record<GranuleKey, number>
  /**
   * Whether the painting is an average rather than a ballot, which is the one
   * thing that changes how it is drawn: a cell of a ballot is one of six
   * ratings and its colour says which, but an average falls between them, so
   * it is drawn in a colour blended between the two (`blendFor`) and the key
   * is a ramp rather than six swatches. No number is printed on a block -- a
   * page of digits is the exact answer and an unreadable one -- but hovering
   * one names its average, for the reader who wants it.
   */
  average?: boolean
  /** The block whose breakdown is open, ringed on the calendar. */
  picked?: Block | null
  /** Makes each block a button that opens its breakdown. Averages only. */
  onPick?: (block: Block) => void
  /** The open block's popover closing by a press outside it, or Escape. */
  onUnpick?: () => void
  /** What the open block's popover holds. */
  details?: ReactNode
}) {
  const h24 = use24HourTime()
  const bounds = useMemo(() => boundsOf(windows, schedule), [windows, schedule])
  const days = useMemo(() => daysOf(bounds), [bounds])
  const daily = isDaily(schedule)
  // Named on the poll's own first day, as the ballot names it; see
  // TimeBallotCard's `zone`.
  const zone = useMemo(
    () => (days[0] ? offsetName(schedule.timezone, days[0]) : null),
    [schedule.timezone, days],
  )

  const theme = useMantineTheme()

  // Averages are taken to one decimal place, and merged into blocks at that
  // precision, so a stretch everybody rated alike is one block rather than a
  // column of cells -- a tenth is finer than two blended colours can be told
  // apart, so nothing visible is lost. Anything above nothing is held at 0.1
  // at least: one voter out of thirty who can make a time is worth a tint,
  // and rounding it away would say nobody could.
  const shown = useMemo(() => {
    if (!average) return painting
    const rounded: Record<GranuleKey, number> = {}
    for (const [key, value] of Object.entries(painting)) {
      rounded[key] = Math.max(0.1, Math.round(value * 10) / 10)
    }
    return rounded
  }, [painting, average])

  function buildEvents(view: ScheduleViewLevel): ScheduleEventData[] {
    return paintingRuns(shown, schedule).map((run) => {
      const times = formatTimeRange(run.from, run.to, h24)
      // A month chip still needs words to have a height; on a poll answered in
      // whole days there are no hours to name, so an average's chip is a bare
      // swatch of its colour.
      const month = daily ? (average ? '\u00a0' : `Rated ${run.value}`) : times
      const color = average ? blendFor(theme.colors, run.value) : colorFor(run.value)
      return {
        id: `${run.day} ${run.from}`,
        title: view === 'month' ? month : '',
        ...runBounds(run),
        color,
        display: view === 'month' ? 'default' : 'background',
        payload: {
          // The rating's own ink, on a month's chips: the library picks a
          // colour too close to the darker end of the ramp to read. See
          // `eventBody` in PaintCalendar.
          ink: average ? inkOn(color) : inkFor(run.value),
          // A blend is not a theme shade, so the calendar would draw it as a
          // faint tint; `eventBody` paints it itself.
          fill: average ? color : undefined,
          // And the number behind a blended colour, under the pointer only.
          hint: average
            ? `${daily ? '' : `${times}: `}average ${run.value.toFixed(1)} of 5`
            : undefined,
          label: average
            ? `${daily ? '' : `${times}, `}${formatDay(run.day)}: average ${run.value.toFixed(1)} of 5`
            : undefined,
          select: average && onPick ? () => onPick(run) : undefined,
          selected: sameBlock(run, picked),
          details: sameBlock(run, picked) ? details : undefined,
          dismiss: onUnpick,
          chip: view === 'month',
        },
      }
    })
  }

  return (
    <Stack gap="xs">
      <Group gap="sm" wrap="wrap" justify="space-between" align="center">
        <Text size="xs" c="dimmed">
          All times are {describeOffset(schedule.timezone, zone)}
        </Text>
        {/* The colours, said once: a calendar of washes with no key is a
            calendar the reader has to have voted on to read. An average's key
            is the ramp it is blended along; a ballot's is its six swatches. */}
        {average ? (
          <Group gap={6} wrap="nowrap" aria-label="Average rating, from 0 to 5" role="img">
            <Text size="xs" c="dimmed">
              0
            </Text>
            <Box
              w={120}
              h={10}
              style={{
                borderRadius: 2,
                background: `linear-gradient(to right, ${RATINGS.map((_, rating) =>
                  blendFor(theme.colors, rating),
                ).join(', ')})`,
              }}
            />
            <Text size="xs" c="dimmed">
              5
            </Text>
          </Group>
        ) : (
          <Group gap={8} wrap="nowrap" aria-label="Ratings, from 0 to 5" role="img">
            {RATINGS.map((level) => (
              <Group key={level.value} gap={4} wrap="nowrap">
                <Box
                  w={10}
                  h={10}
                  style={{ borderRadius: 2, background: swatchFor(Number(level.value)) }}
                />
                <Text size="xs" c="dimmed">
                  {level.label}
                </Text>
              </Group>
            ))}
          </Group>
        )}
      </Group>
      <PaintCalendar
        schedule={schedule}
        bounds={bounds}
        axis={axisFor(schedule.window, bounds, schedule)}
        painting={shown}
        buildEvents={buildEvents}
        confine
        readOnly
      />
    </Stack>
  )
}
