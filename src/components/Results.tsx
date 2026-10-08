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
// Here rather than in main.tsx, so the chart's stylesheet is split off with
// this chunk and a reader filling in a ballot never fetches it. See deferred.ts.
import '@mantine/charts/styles.css'
import { InfoIcon, WarningIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { badgeColor } from '../lib/badgeColors'
import { parseAnswer, pollResultsSchema } from '../lib/rpcSchemas'
import { relabelResults } from '../lib/schedule'
import type {
  FiveStarStep,
  HeadToHeadStep,
  Matchup,
  PollResults,
  Runoff,
  Tiebreak,
} from '../lib/types'
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

/**
 * Which tally endpoint to read. Both return the same shape; the split is
 * only about how the caller proves it's allowed to see it: a session for
 * invite polls, the poll's own link for open ones.
 */
export type ResultsSource = { kind: 'poll'; pollId: string } | { kind: 'open'; pollId: string }

export function Results({
  source,
  initial = null,
}: {
  source: ResultsSource
  /**
   * The tally the read that opened this page already brought, or null when it
   * brought none. `poll_page` carries it on exactly the polls whose page
   * draws this card, so on a poll opened at its results the card is drawn
   * from what is already in hand rather than from a request that could not
   * even be sent until that read came back. See 0050.
   *
   * Null is where this card has always been: the sample poll, a poll that
   * finished while somebody was watching it (the live tick carries no tally),
   * and a crossing between two questions. It reads for itself, exactly as
   * before.
   */
  initial?: PollResults | null
}) {
  // Flattened to primitives so the dependency list is complete without
  // depending on a fresh object identity every render.
  const kind = source.kind
  const key = source.pollId

  // Read every time the card is drawn.
  //
  // This used to be remembered for the life of the tab, on the grounds that a
  // poll whose results are out has taken its last vote and a second read could
  // only say the same thing. It is not true: a creator can open a closed poll
  // again and a reopened poll takes more votes, and can correct its options
  // over the votes it already has — neither is announced to the reader of a
  // tally held here, which would then be of a poll that has moved on. That
  // window is gone rather than narrowed: nothing is held. The head round is
  // cheap now that the full ranking is fetched only when somebody opens it
  // (see FullRanking), which is what makes paying for it on every load the
  // easy trade.
  const [results, setResults] = useState<PollResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The handed-over tally, taken once and then gone. A ref rather than the
  // prop read straight through, because one read's worth of work already done
  // is a thing that gets used up: this card re-reads whenever it is drawn,
  // deliberately — a poll can be reopened and take more votes — and a re-read
  // must never come back with the answer from before it.
  const handoff = useRef(initial)
  // Whether the bars have been let go. They are drawn at nothing for one
  // frame and then at their real lengths, which is what there is to animate:
  // a bar rendered at its length has never been any other length and has
  // nothing to travel from. Once true it stays true — a live tick that brings
  // a new tally moves the bars from where they were, and re-running the whole
  // reveal on every vote would be the page shouting at the reader.
  const [grown, setGrown] = useState(false)

  useEffect(() => {
    if (!results) return
    // Two frames, and both of them are load-bearing. A transition needs the
    // browser to have *painted* the width it is travelling from, and an
    // effect does not guarantee that has happened: React runs this after the
    // commit but the frame may not have been drawn yet, so flipping the width
    // one frame later can still land in the same paint as the zero — which
    // the browser resolves by drawing the bars full length and transitioning
    // nothing. Waiting for the frame after the first is what makes the empty
    // bar real.
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
    if (given) {
      setResults(given)
      return
    }

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
      <Text c="red" size="sm">
        {error}
      </Text>
    )
  }

  if (!results) return <ResultsSkeleton />

  // The one thing a time poll changes about this card, and it is applied to
  // every poll because it costs nothing to: an ordinary poll's options are not
  // window starts, so they come back exactly as they went in. Everything below
  // reads `name` and none of it knows or cares that the name it is reading was
  // an ISO timestamp a line ago. See relabelResults.
  const shown = relabelResults(results)
  const nameById = new Map(shown.options.map((o) => [o.id, o.name]))
  const maxScore = Math.max(1, ...shown.options.map((o) => o.total_score))
  // The scoring round, as far down it as this page goes: the top ten. The
  // bars are scaled against the whole field's best rather than the shown
  // rows' -- the two are the same number, since the rows are taken off the
  // top -- and the full ranking below still receives every option, which is
  // what it names places from. See resultsRows.ts.
  const scoreRound = capRows(shown.options, SCORING_ROWS_MAX)

  // Wrapped so the tally fades in over the shape that was standing in for it,
  // rather than replacing it between two frames. The winner card below has an
  // entrance of its own as well, and needs one: a poll watched as it finishes
  // grows a winner without this ever remounting.
  return (
    <Reveal>
      <Stack gap="md">
        {/* The one card on the page worth arriving rather than appearing. It is
          the answer the whole poll was run to get, and it is also the only
          thing here that was not on screen a moment ago — everything below it
          is a working, and a working does not need announcing. Deliberately
          the same small rise as everything else in the app: this is the end of
          a decision about where to eat, and it should look pleased rather
          than triumphant. The card that says there is no winner gets the same
          entrance, being the same news. */}
        {shown.winner_id && (
          <Reveal>
            <Card withBorder bg="var(--mantine-color-green-light)">
              <Text fw={700} size="lg">
                Winner: {nameById.get(shown.winner_id)}
              </Text>
            </Card>
          </Reveal>
        )}
        {!shown.winner_id && shown.finalists.length === 2 && (
          <Reveal>
            <Card withBorder bg="var(--mantine-color-orange-light)">
              <Group justify="space-between" align="center" gap="sm">
                <Text fw={700} size="lg">
                  No winner
                </Text>
                <CoinFlip pollId={key} finalists={tiedPair(shown, nameById)} />
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
                <Progress
                  value={grown ? (o.total_score / maxScore) * 100 : 0}
                  color={shown.finalists.includes(o.id) ? 'blue' : 'gray'}
                  classNames={{ root: classes.bar, section: classes.section }}
                  // Its place in the tally, which is what the bars are
                  // staggered along; see Results.module.css.
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

        <FullRanking source={source} results={shown} />
      </Stack>
    </Reveal>
  )
}

/**
 * The ties the scoring round had to break to fill the runoff, laid over the
 * scoring card when somebody asks for them. See RoundCard.
 *
 * One section per tie, in the order they were met. A poll needs two only when
 * the first tie filled one runoff slot and a second, lower down, filled the
 * other.
 */
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

/**
 * How a level runoff was settled, laid over the runoff card when somebody
 * asks. See RoundCard.
 *
 * The same shape as the scoring round's tie-break on purpose: numbered rules,
 * each marked as having settled it or not, then a line saying what came of
 * it. The rules are the runoff's own: the higher scoring total, then
 * five-star votes. A runoff level on all three elects nobody, which the card
 * at the top of the page already says.
 */
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
        {voters(runoff.prefers_a)}, so the runoff went to its tie-break.
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

/** One rule a tie-break tried, numbered, and whether it settled the tie. */
function StepHeading({ n, label, decisive }: { n: number; label: string; decisive: boolean }) {
  return (
    <Group gap="xs">
      <Text size="sm" fw={600}>
        {n}. {label}
      </Text>
      <Badge size="xs" variant="light" color={decisive ? badgeColor.done : badgeColor.unsettled}>
        {decisive ? 'Decisive' : 'Still tied'}
      </Badge>
    </Group>
  )
}

const fiveStarVotes = (n: number) => `${n} ${n === 1 ? 'five-star vote' : 'five-star votes'}`

/**
 * The colours of the runoff's answers: either finalist, or neither.
 *
 * Two hues rather than the one blue both finalists wear in the scoring round,
 * because here they are being told apart rather than picked out. Blue and
 * violet are the two ends of the app's own gradient. "Scored them equally" is
 * grey, like the options that missed the runoff, and is only ever drawn when
 * it is the whole chart (see RunoffChart). Colour is never the only cue: each
 * name is written under its own end of the arc.
 */
const RUNOFF_COLORS = { a: 'blue.6', b: 'violet.6', equal: 'gray.5' } as const

const cssColor = (color: string) => `var(--mantine-color-${color.replace('.', '-')})`

/** How wide the runoff's half pie is; it stands half as tall. */
const CHART_SIZE = 240

/**
 * The runoff as half a pie: one finalist's voters from the left and the
 * other's from the right.
 *
 * **Two slices at most.** A voter who scored both finalists the same took
 * neither side, and the runoff is decided by the voters who did, so a grey
 * slice between the two would make the result look closer than it was. They
 * are still counted, in the line under the chart. The one time they are drawn
 * is when nobody preferred either finalist, where they are the whole arc:
 * a grey half pie is a truthful picture of a runoff nobody took a side in,
 * and an empty space is not.
 *
 * Half a pie, because a runoff is only ever two options and the question is
 * which side of the middle the vote fell on. The top of the arc is the
 * halfway mark, so a reader can see who won before reading a number.
 *
 * It is drawn as a full pie whose centre sits on the bottom edge of a box half
 * its height (`cy: '100%'`), so the half that is never drawn takes no room on
 * the page.
 *
 * It sweeps in the way the scoring bars grow, and for the same reason: the
 * comparison happens on screen. Not under reduced motion, which the rule in
 * index.css cannot reach here, because the chart animates from JavaScript.
 * 500ms is `--motion-slow`, written as a number because that is all the chart
 * takes.
 *
 * Hidden from screen readers and kept out of the tab order: the lines under
 * it say everything the arc does, in words.
 */
function RunoffChart({ a, b, runoff }: { a: string; b: string; runoff: Runoff }) {
  const reducedMotion = useReducedMotion(false, { getInitialValueInEffect: false })
  const nobodyChose = runoff.prefers_a + runoff.prefers_b === 0
  // A zero slice is still drawn as a hairline of stroke; leaving it out draws
  // nothing, which is what it is. And with no ballots at all there is no
  // chart, only the lines under it.
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
        <Box aria-hidden>
          <PieChart
            data={data}
            size={CHART_SIZE}
            startAngle={180}
            endAngle={0}
            accessibilityLayer={false}
            style={{ height: CHART_SIZE / 2, minHeight: CHART_SIZE / 2 }}
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
        {/* No swatch for a slice the chart did not draw. */}
        {nobodyChose && runoff.ties > 0 && <Swatch color={RUNOFF_COLORS.equal} />}
        <Text size="sm" c="dimmed">
          {voters(runoff.ties)} scored both finalists equally.
        </Text>
      </Group>
    </Stack>
  )
}

/**
 * One finalist, under its own end of the arc: its colour, its name, and the
 * voters who preferred it. The swatch is on the outside edge on both sides, so
 * the two read as a pair facing each other.
 */
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
 * Something that happened to this poll after people started voting in it,
 * stated on the results themselves.
 *
 * Both of the things it says are consequences of rules this app deliberately
 * relaxed: a creator may now correct an option list that already has ballots
 * scored against it, and may open a closed poll again rather than duplicating
 * it. Neither is a mistake, and neither is announced as one — but both of them
 * mean the tally below rests on something a reader would otherwise assume did
 * not happen, and a result is only worth as much as what the reader knows
 * about how it was reached.
 *
 * Yellow rather than red: nothing here is broken, and the card is not the
 * news. Yellow rather than the orange the no-winner card wears, so that a tie
 * and a caveat are never the same colour on the same screen.
 *
 * The database says *whether*, not *what*: see the flags on `polls`. A poll
 * keeps no history of which option was renamed or whose vote moved, because
 * the ballots it holds are secret and were secret when they were cast, so
 * there is nothing more truthful to put here than the fact itself.
 */
function Caveat({ children }: { children: ReactNode }) {
  return (
    <Card withBorder bg="var(--mantine-color-yellow-light)" p="sm">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        {/* Nudged down to the text's own line, since the sentence wraps to two
            or three on a phone and an icon centred against the block would
            float away from the words it belongs to. */}
        <WarningIcon size={18} weight="fill" style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="sm">{children}</Text>
      </Group>
    </Card>
  )
}

/**
 * The two finalists of a tie, named, as a pair rather than as a list.
 *
 * `finalists` arrives from the tally as an array of ids, and the coin takes
 * exactly two of them — so the tuple is where "exactly two" is stated, and the
 * component never has to wonder what to do with one or three. The only caller
 * is the card above, which has already established the length.
 *
 * A name is looked up rather than carried, and falls back to the id: every
 * finalist is an option of the same tally and so is always in the map, and a
 * coin showing a uuid would be a visible bug rather than a page that failed to
 * draw.
 */
function tiedPair(results: PollResults, nameById: Map<string, string>): [Finalist, Finalist] {
  const named = (id: string): Finalist => ({ id, name: nameById.get(id) ?? id })

  return [named(results.finalists[0]), named(results.finalists[1])]
}

/**
 * The head-to-head tie-break, in the units the ballots were cast in.
 *
 * The rule counts matchups: every option in the tied group is compared with
 * every other, one pair at a time, and the option more voters scored higher
 * wins that pair. Reporting only the totals produced the least useful line
 * this page has ever shown; two options tied for one runoff slot meet
 * exactly once, and if that meeting is level they have won nothing, so the
 * step read "0 matchups won" twice and left the reader to guess whether that
 * meant a tie, an error, or a rule that had not run.
 *
 * So a two-option tie is reported as the one comparison it actually is,
 * in the same words the runoff below uses for the same arithmetic, and the
 * word "matchup" does not appear at all. A larger group keeps the totals,
 * with three options they are the point, since the rule is asking which one
 * beat the most others; and shows the pairs they were counted from
 * underneath.
 */
function HeadToHead({ step }: { step: HeadToHeadStep }) {
  const { matchups } = step

  if (matchups.length === 1) {
    const m = matchups[0]
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

  // Both lists are cut short on a group large enough to need it, and the pair
  // list is the one that needs it first: pairs grow as the square of the group,
  // so a dozen options tied at the top score is sixty-six lines of working
  // under a tie-break whose answer is the three lines above them. The
  // denominator stays the whole group -- "3 of 29 matchups won" is the count
  // the rule made its decision on, whether or not all 29 are listed.
  const totals = capRows(step.results)
  const pairs = capRows(matchups)

  return (
    <Stack gap={2} pl="md">
      <Text size="sm" c="dimmed">
        Each option meets each of the others one on one, and wins that matchup if more voters scored
        it higher.
      </Text>
      {totals.rows.map((r) => (
        <Text key={r.id} size="sm" c="dimmed">
          <strong>{r.name}</strong>: {r.value} of {step.results.length - 1} matchups won
        </Text>
      ))}
      {totals.hidden > 0 && <Rest hidden={totals.hidden} what="option" />}
      <Stack gap={2} mt={4}>
        {pairs.rows.map((m) => (
          <MatchupLine key={`${m.a}-${m.b}`} matchup={m} />
        ))}
        {pairs.hidden > 0 && <Rest hidden={pairs.hidden} what="pair" />}
      </Stack>
    </Stack>
  )
}

/**
 * The five-star tie-break: how many ballots gave each tied option full marks.
 *
 * Cut short at the same twenty as everything else here. The options this rule
 * settles a tie *for* are at the top of it — it is read in descending order —
 * so what a long group loses from the bottom is the options that were never
 * going to advance on it.
 */
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

/**
 * What a cut-short list left out, in the list's own place.
 *
 * Said rather than implied, because a list that stops at twenty and says
 * nothing is a list claiming the poll had twenty of whatever it is counting —
 * and on this page of all pages a reader is checking numbers against each
 * other. Dimmed and last: it is the one line here that is about the page
 * rather than about the poll.
 */
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

/** One pair of the tied group, and which way its voters went. */
function MatchupLine({ matchup }: { matchup: Matchup }) {
  const equal = matchup.prefers_a === matchup.prefers_b
  const [ahead, behind, won, lost] =
    matchup.prefers_a >= matchup.prefers_b
      ? [matchup.a_name, matchup.b_name, matchup.prefers_a, matchup.prefers_b]
      : [matchup.b_name, matchup.a_name, matchup.prefers_b, matchup.prefers_a]

  if (equal) {
    return (
      <Text size="sm" c="dimmed">
        <strong>{matchup.a_name}</strong> vs <strong>{matchup.b_name}</strong>: {voters(won)} each,
        so neither wins
      </Text>
    )
  }

  return (
    <Text size="sm" c="dimmed">
      <strong>{ahead}</strong> vs <strong>{behind}</strong>: {voters(won)} to {lost}
    </Text>
  )
}

/**
 * What an option said, once the ballot that said it is gone.
 *
 * A description is a voting aid: on the ballot it belongs under the option's
 * name, where it is read while the decision is being made. By the time the
 * results are out that decision has been taken, and a paragraph beside a bar
 * of points is in the way of the number it is sitting next to. But it is
 * also the only record of what the option actually was, and a poll read back
 * months later is exactly when "Option B" needs explaining.
 *
 * So it is here, and it is folded away: one dimmed mark beside the name,
 * showing nothing at all on the options that never had one; which is
 * nearly all of them. A popover rather than a tooltip, because a tooltip on
 * a phone is a thing that cannot be opened.
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
