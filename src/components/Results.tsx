import { useEffect, useRef, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Card,
  Group,
  Popover,
  Progress,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { InfoIcon } from '@phosphor-icons/react'
import { supabase } from '../lib/supabase'
import { openPollRpc, type RpcAnswer } from '../lib/samplePoll'
import { badgeColor } from '../lib/badgeColors'
import { parseAnswer, pollResultsSchema } from '../lib/rpcSchemas'
import { relabelResults } from '../lib/schedule'
import type { HeadToHeadStep, Matchup, PollResults } from '../lib/types'
import { FullRanking } from './FullRanking'
import { NameList } from './NameList'
import { OptionDescription } from './OptionDescription'
import { ResultsSkeleton } from './Skeletons'
import { voters } from '../lib/plural'

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
  // only say the same thing. True — unless the creator resets the poll, which
  // deletes every vote and is announced to nobody, and then the tally held
  // here was of votes that no longer exist. That window is gone rather than
  // narrowed: nothing is held. The head round is cheap now that the full
  // ranking is fetched only when somebody opens it (see FullRanking), which
  // is what makes paying for it on every load the easy trade.
  const [results, setResults] = useState<PollResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The handed-over tally, taken once and then gone. A ref rather than the
  // prop read straight through, because one read's worth of work already done
  // is a thing that gets used up: this card re-reads whenever it is drawn,
  // deliberately — a reset takes a poll's votes away and tells nobody — and a
  // re-read must never come back with the answer from before it.
  const handoff = useRef(initial)

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

  return (
    <Stack gap="md">
      {shown.winner_id && (
        <Card withBorder bg="var(--mantine-color-green-light)">
          <Text fw={700} size="lg">
            Winner: {nameById.get(shown.winner_id)}
          </Text>
        </Card>
      )}
      {!shown.winner_id && shown.finalists.length === 2 && (
        <Card withBorder bg="var(--mantine-color-orange-light)">
          <Text fw={700} size="lg">
            No winner
          </Text>
        </Card>
      )}

      <Stack gap={2}>
        <Title order={4}>Score round</Title>
        <Card withBorder p="sm">
          <Stack gap="xs">
            {shown.options.map((o) => (
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
                  value={(o.total_score / maxScore) * 100}
                  color={shown.finalists.includes(o.id) ? 'blue' : 'gray'}
                />
              </div>
            ))}
          </Stack>
        </Card>
      </Stack>

      {shown.tiebreaks.length > 0 && (
        <Stack gap={2}>
          <Title order={4}>Tie-break{shown.tiebreaks.length > 1 ? 's' : ''}</Title>
          {shown.tiebreaks.map((tb, i) => (
            <Card withBorder key={i} p="sm">
              <Stack gap="xs">
                <Text size="sm">
                  <NameList names={tb.tied} /> tied at {tb.tied_at} pts for{' '}
                  {tb.slots === 1 ? 'the last runoff slot' : `${tb.slots} runoff slots`}.
                </Text>
                {tb.steps.map((step, j) => (
                  <Stack key={step.rule} gap={2}>
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        {j + 1}.{' '}
                        {step.rule === 'head_to_head'
                          ? 'Head-to-head preference'
                          : 'Five-star votes'}
                      </Text>
                      <Badge
                        size="xs"
                        variant="light"
                        color={step.decisive ? badgeColor.done : badgeColor.unsettled}
                      >
                        {step.decisive ? 'Decisive' : 'Still tied'}
                      </Badge>
                    </Group>
                    {step.rule === 'head_to_head' ? (
                      <HeadToHead step={step} />
                    ) : (
                      step.results.map((r) => (
                        <Text key={r.id} size="sm" c="dimmed" pl="md">
                          <strong>{r.name}</strong>: {r.value}{' '}
                          {r.value === 1 ? 'five-star vote' : 'five-star votes'}
                        </Text>
                      ))
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
            </Card>
          ))}
        </Stack>
      )}

      {shown.runoff && shown.finalists.length === 2 && (
        <Stack gap={2}>
          <Title order={4}>Automatic runoff round</Title>
          <Card withBorder p="sm">
            <Stack gap="xs">
              <Text size="sm">
                <strong>{nameById.get(shown.finalists[0])}</strong>:{' '}
                {voters(shown.runoff.prefers_a)} preferred
              </Text>
              <Text size="sm">
                <strong>{nameById.get(shown.finalists[1])}</strong>:{' '}
                {voters(shown.runoff.prefers_b)} preferred
              </Text>
              <Text size="sm" c="dimmed">
                {voters(shown.runoff.ties)} scored both finalists equally.
              </Text>
              {shown.runoff.resolved_by === 'higher_score' && (
                <Text size="sm">
                  The runoff tied, so it went to {nameById.get(shown.winner_id ?? '')} on the higher
                  score-round total.
                </Text>
              )}
              {shown.runoff.resolved_by === 'five_star_votes' && (
                <>
                  <Text size="sm">
                    The runoff tied and both finalists have identical score totals, so it went to{' '}
                    {nameById.get(shown.winner_id ?? '')} on five-star votes.
                  </Text>
                  <Text size="sm" c="dimmed">
                    {nameById.get(shown.finalists[0])}: {shown.runoff.five_stars_a} ·{' '}
                    {nameById.get(shown.finalists[1])}: {shown.runoff.five_stars_b}
                  </Text>
                </>
              )}
              {shown.runoff.resolved_by === 'unresolved' && (
                <Text size="sm" c="orange">
                  The runoff tied, both finalists have identical score totals, and both were given
                  five stars on the same number of ballots, so there is no winner.
                </Text>
              )}
            </Stack>
          </Card>
        </Stack>
      )}

      <FullRanking source={source} results={shown} />
    </Stack>
  )
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

  return (
    <Stack gap={2} pl="md">
      <Text size="sm" c="dimmed">
        Each option meets each of the others one on one, and wins that matchup if more voters scored
        it higher.
      </Text>
      {step.results.map((r) => (
        <Text key={r.id} size="sm" c="dimmed">
          {r.name}: {r.value} of {step.results.length - 1} matchups won
        </Text>
      ))}
      <Stack gap={2} mt={4}>
        {matchups.map((m) => (
          <Text key={`${m.a}-${m.b}`} size="sm" c="dimmed">
            {matchupLine(m)}
          </Text>
        ))}
      </Stack>
    </Stack>
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
function matchupLine(m: Matchup): string {
  const equal = m.prefers_a === m.prefers_b
  const [ahead, behind, won, lost] =
    m.prefers_a >= m.prefers_b
      ? [m.a_name, m.b_name, m.prefers_a, m.prefers_b]
      : [m.b_name, m.a_name, m.prefers_b, m.prefers_a]

  return equal
    ? `${m.a_name} vs ${m.b_name}: ${voters(won)} each, so neither wins`
    : `${ahead} vs ${behind}: ${voters(won)} to ${lost}`
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
