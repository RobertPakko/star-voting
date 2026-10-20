import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActionIcon,
  Badge,
  Box,
  Card,
  Divider,
  Group,
  Popover,
  Progress,
  Stack,
  Text,
} from '@mantine/core'
import { PieChart } from '@mantine/charts'
import { useReducedMotion } from '@mantine/hooks'
// Imported here so the chart CSS ships in this lazy chunk.
import '@mantine/charts/styles.css'
import { InfoIcon, WarningIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { badgeColor } from '../lib/badgeColors'
import { parseAnswer, pollResultsSchema } from '../lib/rpcSchemas'
import { describeLength, meetingMinutes, relabelResults } from '../lib/schedule'
import type { MeetingEvent } from '../lib/calendarEvent'
import { shareLinkFor } from '../lib/shareLink'
import { use24HourTime } from '../lib/clock'
import type {
  FiveStarStep,
  HeadToHeadStep,
  PollResults,
  PollSchedule,
  Runoff,
  Tiebreak,
} from '../lib/types'
import { AddToCalendar } from './AddToCalendar'
import { CoinFlip, type Finalist } from './CoinFlip'
import { FullRanking } from './FullRanking'
import { NameList } from './NameList'
import { OptionDescription } from './OptionDescription'
import { Reveal } from './Reveal'
import { RoundCard } from './RoundCard'
import { ResultsSkeleton } from './Skeletons'
import { count, voters } from '../lib/plural'
import { capRows, RESULTS_ROWS_MAX, SCORING_ROWS_MAX } from '../lib/resultsRows'
import classes from './Results.module.css'

/** Which tally endpoint to read: a session for invite polls, the link for open ones. */
export type ResultsSource = { kind: 'poll'; pollId: string } | { kind: 'open'; pollId: string }

export function Results({
  source,
  initial = null,
  live = false,
  meeting = null,
}: {
  source: ResultsSource
  /** A time poll's title and schedule, for *Add to calendar*. Null otherwise. */
  meeting?: { title: string; schedule: PollSchedule } | null
  /** The tally `poll_page` already carried; null means read it here. */
  initial?: PollResults | null
  /** The results came out while the reader watched; see `landed` in Results.module.css. */
  live?: boolean
}) {
  const h24 = use24HourTime()
  const kind = source.kind
  const key = source.pollId

  // Read on every draw, never cached: a closed poll can be reopened or have
  // its options corrected, unannounced to a tally held here.
  const [results, setResults] = useState<PollResults | null>(initial)
  const [error, setError] = useState<string | null>(null)
  // The handed-over tally, used once; a later re-read must not reuse it.
  const handoff = useRef(initial)
  // Bars render at zero, then grow. Stays true so a live update moves bars
  // from where they were instead of replaying the reveal.
  const [grown, setGrown] = useState(false)

  useEffect(() => {
    if (!results) return
    // Two frames: the zero width must actually be painted before the
    // transition, and one rAF after an effect doesn't guarantee that.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setGrown(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [results])

  useEffect(() => {
    const given = handoff.current
    handoff.current = null
    if (given) return

    let cancelled = false
    const request: PromiseLike<RpcAnswer> =
      kind === 'poll'
        ? supabase.rpc('get_poll_results', { p_poll_id: key })
        : openPollRpc('open_poll_results', { p_poll_id: key })

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) return setError(rpcError.message)
      const { value, error: shape } = parseAnswer(pollResultsSchema, 'the tally', data)
      if (value) setResults(value)
      else setError(shape)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key])

  if (error) {
    return (
      <Text role="alert" c="red" size="sm">
        {error}
      </Text>
    )
  }

  if (!results) return <ResultsSkeleton />

  // Time-poll names become readable; ordinary names pass through.
  const shown = relabelResults(results, h24)
  const nameById = new Map(shown.options.map((o) => [o.id, o.name]))
  const maxScore = Math.max(1, ...shown.options.map((o) => o.total_score))
  // Capped for the page; the full ranking still gets every option.
  const scoreRound = capRows(shown.options, SCORING_ROWS_MAX)

  // A calendar event from the *raw* option name, which is the actual instant.
  const startById = new Map(results.options.map((o) => [o.id, o.name]))
  const eventFor = (id: string): MeetingEvent | null => {
    const start = startById.get(id)
    if (!meeting || !start) return null
    return {
      title: meeting.title,
      start,
      minutes: meetingMinutes(meeting.schedule),
      details: shareLinkFor({ id: key }),
      uid: `${key}-${start}@choicelab.app`,
    }
  }
  const winnerEvent = shown.winner_id ? eventFor(shown.winner_id) : null

  return (
    <Reveal>
      <Stack gap="md">
        {/* Its own entrance, since a poll that finishes while watched grows
            this card without the rest remounting. */}
        {shown.winner_id && (
          <Reveal>
            <Card
              withBorder
              bg="var(--mantine-color-green-light)"
              className={live ? classes.landed : undefined}
            >
              <Group justify="space-between" align="center" gap="sm">
                <Text fw={700} size="lg">
                  Winner: {nameById.get(shown.winner_id)}
                  {/* A time poll's meeting length, kept on one line. */}
                  {winnerEvent && (
                    <>
                      {' '}
                      <span style={{ whiteSpace: 'nowrap' }}>
                        ({describeLength(winnerEvent.minutes)})
                      </span>
                    </>
                  )}
                </Text>
                {winnerEvent && <AddToCalendar event={winnerEvent} />}
              </Group>
            </Card>
          </Reveal>
        )}
        {!shown.winner_id && shown.finalists.length === 2 && (
          <Reveal>
            <Card
              withBorder
              bg="var(--mantine-color-orange-light)"
              className={live ? classes.landed : undefined}
              style={
                { '--landed-ring': 'var(--mantine-color-orange-filled)' } as React.CSSProperties
              }
            >
              <Group justify="space-between" align="center" gap="sm">
                <Text fw={700} size="lg">
                  No winner
                </Text>
                <CoinFlip
                  pollId={key}
                  finalists={tiedPair(shown, nameById)}
                  eventFor={meeting ? eventFor : undefined}
                />
              </Group>
            </Card>
          </Reveal>
        )}

        {shown.options_edited_after_votes && (
          <Caveat>
            The options for this poll were edited after votes had been cast; so the integrity of
            this poll is a little suspect.
          </Caveat>
        )}
        {shown.votes_after_reveal && (
          <Caveat>
            Votes were added or changed after the results were revealed; so the integrity of this
            poll is a little suspect.
          </Caveat>
        )}

        {/* The runoff comes first: it is what elected the winner, and the
            score round's leader often isn't the winner. */}
        {shown.runoff && shown.finalists.length === 2 && (
          <RoundCard
            title="Runoff"
            tieBreak={
              shown.runoff.resolved_by === 'preference' ? null : (
                <RunoffTieBreak results={shown} runoff={shown.runoff} nameById={nameById} />
              )
            }
          >
            <RunoffChart
              a={nameById.get(shown.finalists[0]) ?? ''}
              b={nameById.get(shown.finalists[1]) ?? ''}
              runoff={shown.runoff}
            />
          </RoundCard>
        )}

        <RoundCard
          title="Scoring"
          tieBreak={
            shown.tiebreaks.length > 0 ? <ScoringTieBreaks tiebreaks={shown.tiebreaks} /> : null
          }
          tieBreakLabel={shown.tiebreaks.length > 1 ? 'tie-breaks' : 'tie-break'}
        >
          <Stack gap="xs">
            {scoreRound.rows.map((o, index) => (
              <div key={o.id}>
                <Group justify="space-between" mb={2} wrap="nowrap" gap="xs">
                  <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                    <Text size="sm" fw={shown.finalists.includes(o.id) ? 700 : 400} truncate>
                      {o.name}
                    </Text>
                    {o.description && <OptionNote name={o.name} description={o.description} />}
                  </Group>
                  <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {o.total_score} pts (avg {o.average_score})
                  </Text>
                </Group>
                {/* The points are already in words above. */}
                <Progress
                  aria-hidden
                  value={grown ? (o.total_score / maxScore) * 100 : 0}
                  color={shown.finalists.includes(o.id) ? 'blue' : 'var(--muted-bar)'}
                  classNames={{ root: classes.bar, section: classes.section }}
                  // Staggers the bars; see Results.module.css.
                  style={{ '--row': index } as React.CSSProperties}
                />
              </div>
            ))}
            {scoreRound.hidden > 0 && (
              <Text size="sm" c="dimmed">
                The top {scoreRound.rows.length} of {shown.options.length} options. Open the full
                ranking below to see them all.
              </Text>
            )}
          </Stack>
        </RoundCard>

        <FullRanking source={source} results={shown} />
      </Stack>
    </Reveal>
  )
}

/** The score round's tie-breaks, one section per tie in the order met. */
function ScoringTieBreaks({ tiebreaks }: { tiebreaks: Tiebreak[] }) {
  return (
    <Stack gap="sm">
      {tiebreaks.map((tb, i) => (
        <Stack key={i} gap="xs">
          {i > 0 && <Divider />}
          <Text size="sm">
            <NameList names={tb.tied} max={RESULTS_ROWS_MAX} /> tied at {tb.tied_at} pts for{' '}
            {tb.slots === 1 ? 'the last runoff slot' : `${tb.slots} runoff slots`}.
          </Text>
          {tb.steps.map((step, j) => (
            <Stack key={step.rule} gap={2}>
              <StepHeading
                n={j + 1}
                label={step.rule === 'head_to_head' ? 'Head-to-head preference' : 'Five-star votes'}
                decisive={step.decisive}
              />
              {step.rule === 'head_to_head' ? (
                <HeadToHead step={step} />
              ) : (
                <FiveStars step={step} />
              )}
            </Stack>
          ))}

          <Text size="sm" c={tb.resolved_by === 'random' ? 'orange' : undefined}>
            {tb.resolved_by === 'random'
              ? renderAdvancedNames(
                  tb.advanced,
                  'Still tied after every rule; ',
                  ' advanced by random selection.',
                )
              : renderAdvancedNames(
                  tb.advanced,
                  '',
                  ` advanced on ${
                    tb.resolved_by === 'head_to_head'
                      ? 'head-to-head preference'
                      : 'five-star votes'
                  }.`,
                )}
          </Text>
        </Stack>
      ))}
    </Stack>
  )
}

/** How a level runoff was settled: higher score total, then five-star votes. */
function RunoffTieBreak({
  results,
  runoff,
  nameById,
}: {
  results: PollResults
  runoff: Runoff
  nameById: Map<string, string>
}) {
  const [aId, bId] = results.finalists
  const a = nameById.get(aId) ?? aId
  const b = nameById.get(bId) ?? bId
  const total = (id: string) => results.options.find((o) => o.id === id)?.total_score ?? 0
  const winner = results.winner_id ? nameById.get(results.winner_id) : null

  return (
    <Stack gap="xs">
      <Text size="sm">
        <strong>{a}</strong> and <strong>{b}</strong> were each preferred by{' '}
        {voters(runoff.prefers_a)}
      </Text>

      <Stack gap={2}>
        <StepHeading
          n={1}
          label="Higher scoring total"
          decisive={runoff.resolved_by === 'higher_score'}
        />
        <Text size="sm" c="dimmed" pl="md">
          <strong>{a}</strong>: {total(aId)} pts
        </Text>
        <Text size="sm" c="dimmed" pl="md">
          <strong>{b}</strong>: {total(bId)} pts
        </Text>
      </Stack>

      {runoff.resolved_by !== 'higher_score' && (
        <Stack gap={2}>
          <StepHeading
            n={2}
            label="Five-star votes"
            decisive={runoff.resolved_by === 'five_star_votes'}
          />
          <Text size="sm" c="dimmed" pl="md">
            <strong>{a}</strong>: {fiveStarVotes(runoff.five_stars_a)}
          </Text>
          <Text size="sm" c="dimmed" pl="md">
            <strong>{b}</strong>: {fiveStarVotes(runoff.five_stars_b)}
          </Text>
        </Stack>
      )}

      {runoff.resolved_by === 'unresolved' || !winner ? (
        <Text size="sm" c="orange">
          Level on preference, on points and on five-star votes, so there is no winner.
        </Text>
      ) : (
        <Text size="sm">
          <strong>{winner}</strong> won on{' '}
          {runoff.resolved_by === 'higher_score' ? 'the higher scoring total' : 'five-star votes'}.
        </Text>
      )}
    </Stack>
  )
}

/** "First rule: …", named rather than numbered (a lone "1." looks like a truncated list). */
function StepHeading({ n, label, decisive }: { n: number; label: string; decisive: boolean }) {
  return (
    <Group gap="xs">
      <Text size="sm" fw={600}>
        {RULE_ORDINALS[n - 1] ?? `Rule ${n}`}: {label}
      </Text>
      <Badge size="xs" variant="light" color={decisive ? badgeColor.done : badgeColor.unsettled}>
        {decisive ? 'Decisive' : 'Still tied'}
      </Badge>
    </Group>
  )
}

/** Every tie-break has at most two rules. */
const RULE_ORDINALS = ['First rule', 'Second rule']

const fiveStarVotes = (n: number) => `${n} ${n === 1 ? 'five-star vote' : 'five-star votes'}`

/**
 * Runoff colours: blue and violet (the app's gradient ends) to tell the
 * finalists apart, grey for "scored equally". Names are always written too.
 */
const RUNOFF_COLORS = { a: 'blue.6', b: 'violet.6', equal: 'gray.5' } as const

const cssColor = (color: string) => `var(--mantine-color-${color.replace('.', '-')})`

/** The half pie's width; it is half as tall. */
const CHART_SIZE = 240

/**
 * The runoff as a half pie, one finalist from each side, so the winner is
 * visible past the top. Voters who scored both equally are left out (they
 * don't decide it) except when nobody chose a side. Drawn as a full pie
 * centred on the bottom edge of a half-height box. The chart animates from
 * JS, so reduced motion is checked here; 500ms is `--motion-slow`.
 */
function RunoffChart({ a, b, runoff }: { a: string; b: string; runoff: Runoff }) {
  const reducedMotion = useReducedMotion(false, { getInitialValueInEffect: false })
  const nobodyChose = runoff.prefers_a + runoff.prefers_b === 0
  // Zero slices would still draw a hairline of stroke.
  const data = (
    nobodyChose
      ? [{ name: 'Scored equally', value: runoff.ties, color: RUNOFF_COLORS.equal }]
      : [
          { name: a, value: runoff.prefers_a, color: RUNOFF_COLORS.a },
          { name: b, value: runoff.prefers_b, color: RUNOFF_COLORS.b },
        ]
  ).filter((d) => d.value > 0)

  return (
    <Stack gap="xs" align="center">
      {data.length > 0 && (
        // Inert too: the chart draws a focusable surface.
        <Box aria-hidden inert>
          <PieChart
            data={data}
            size={CHART_SIZE}
            startAngle={180}
            endAngle={0}
            accessibilityLayer={false}
            style={{ height: CHART_SIZE / 2, minHeight: CHART_SIZE / 2, marginTop: 8 }}
            pieProps={{
              cy: '100%',
              isAnimationActive: !reducedMotion,
              animationDuration: 500,
              animationEasing: 'ease-out',
            }}
          />
        </Box>
      )}
      <Group
        justify="space-between"
        align="flex-start"
        wrap="nowrap"
        gap="md"
        w="100%"
        maw={CHART_SIZE + 120}
      >
        <RunoffSide name={a} preferred={runoff.prefers_a} color={RUNOFF_COLORS.a} side="left" />
        <RunoffSide name={b} preferred={runoff.prefers_b} color={RUNOFF_COLORS.b} side="right" />
      </Group>
      <Group gap={6} wrap="nowrap" justify="center">
        {nobodyChose && runoff.ties > 0 && <Swatch color={RUNOFF_COLORS.equal} />}
        <Text size="sm" c="dimmed">
          {voters(runoff.ties)} scored both finalists equally.
        </Text>
      </Group>
    </Stack>
  )
}

/** One finalist under its end of the arc, swatch on the outside edge. */
function RunoffSide({
  name,
  preferred,
  color,
  side,
}: {
  name: string
  preferred: number
  color: string
  side: 'left' | 'right'
}) {
  return (
    <Stack
      gap={0}
      align={side === 'left' ? 'flex-start' : 'flex-end'}
      style={{ flex: 1, minWidth: 0 }}
    >
      <Group
        gap={6}
        wrap="nowrap"
        style={{ minWidth: 0, flexDirection: side === 'left' ? 'row' : 'row-reverse' }}
      >
        <Swatch color={color} />
        <Text size="sm" fw={700} ta={side} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          {name}
        </Text>
      </Group>
      <Text size="sm" c="dimmed" ta={side}>
        {voters(preferred)} preferred
      </Text>
    </Stack>
  )
}

function Swatch({ color }: { color: string }) {
  return (
    <Box
      w={10}
      h={10}
      style={{ borderRadius: 2, flexShrink: 0, backgroundColor: cssColor(color) }}
    />
  )
}

/**
 * A caveat on the result (options edited after votes, or votes after the
 * reveal). Yellow: not an error, and distinct from the no-winner orange.
 * The database records only that it happened, not what.
 */
function Caveat({ children }: { children: ReactNode }) {
  return (
    <Card withBorder bg="var(--mantine-color-yellow-light)" p="sm">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        {/* Aligned with the first line, since the text wraps on a phone. */}
        <WarningIcon size={18} weight="fill" style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="sm">{children}</Text>
      </Group>
    </Card>
  )
}

/** The two tied finalists, as the pair `CoinFlip` takes. */
function tiedPair(results: PollResults, nameById: Map<string, string>): [Finalist, Finalist] {
  const named = (id: string): Finalist => ({ id, name: nameById.get(id) ?? id })

  return [named(results.finalists[0]), named(results.finalists[1])]
}

/** The head-to-head step: only two-way ties use it, so it is one comparison. */
function HeadToHead({ step }: { step: HeadToHeadStep }) {
  const m = step.matchups[0]
  if (!m) return null

  return (
    <Stack gap={2} pl="md">
      <Text size="sm" c="dimmed">
        <strong>{m.a_name}</strong>: {voters(m.prefers_a)} preferred it
      </Text>
      <Text size="sm" c="dimmed">
        <strong>{m.b_name}</strong>: {voters(m.prefers_b)} preferred it
      </Text>
      {m.ties > 0 && (
        <Text size="sm" c="dimmed">
          {voters(m.ties)} scored them equally.
        </Text>
      )}
    </Stack>
  )
}

/** Five-star counts, capped; the cut-off tail is options that weren't going to advance. */
function FiveStars({ step }: { step: FiveStarStep }) {
  const { rows, hidden } = capRows(step.results)

  return (
    <>
      {rows.map((r) => (
        <Text key={r.id} size="sm" c="dimmed" pl="md">
          <strong>{r.name}</strong>: {fiveStarVotes(r.value)}
        </Text>
      ))}
      {hidden > 0 && <Rest hidden={hidden} what="option" pl="md" />}
    </>
  )
}

/** Says how many a capped list left out, so it never looks complete. */
function Rest({ hidden, what, pl }: { hidden: number; what: string; pl?: string }) {
  return (
    <Text size="sm" c="dimmed" pl={pl}>
      …and {count(hidden, what)} not shown.
    </Text>
  )
}

function renderAdvancedNames(
  advanced: { id: string; name: string }[],
  prefix: string,
  suffix: string,
) {
  return (
    <>
      {prefix}
      <NameList names={advanced} />
      {suffix}
    </>
  )
}

/**
 * An option's description, folded into a popover beside its name (a tooltip
 * can't be opened on a phone). Shown only for options that have one.
 */
function OptionNote({ name, description }: { name: string; description: string }) {
  return (
    <Popover width={280} position="bottom-start" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          radius="xl"
          aria-label={`What ${name} said`}
        >
          <InfoIcon size={14} aria-hidden />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {name}
          </Text>
          <OptionDescription description={description} />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
