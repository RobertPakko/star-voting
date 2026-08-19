import { useEffect, useState } from 'react'
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
import { supabase } from '../lib/supabase'
import { badgeColor } from '../lib/badgeColors'
import { recall, remember } from '../lib/settled'
import type { Matchup, PollResults, TiebreakStep } from '../lib/types'
import { FullRanking } from './FullRanking'
import { OptionDescription } from './OptionDescription'
import { ResultsSkeleton } from './Skeletons'
import { voters } from '../lib/plural'

/**
 * Which tally endpoint to read. Both return the same shape — the split is
 * only about how the caller proves it's allowed to see it: a session for
 * invite polls, the share token for open ones.
 */
export type ResultsSource = { kind: 'poll'; pollId: string } | { kind: 'token'; token: string }

export function Results({ source }: { source: ResultsSource }) {
  // Flattened to primitives so the dependency list is complete without
  // depending on a fresh object identity every render.
  const kind = source.kind
  const key = source.kind === 'poll' ? source.pollId : source.token
  const rpc = kind === 'poll' ? 'get_poll_results' : 'open_poll_results'

  // A tally this tab has already been given, rendered without a request and
  // therefore without a skeleton: the poll it describes has taken its last
  // vote, so there is nothing a second read could tell us. See lib/settled.ts
  // for why that is in memory only.
  const [results, setResults] = useState<PollResults | null>(
    () => recall<PollResults>(rpc, key) ?? null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Checked again here rather than only in the initial state, because one
    // mounted Results can be handed a different poll.
    const cached = recall<PollResults>(rpc, key)
    if (cached) {
      setResults(cached)
      return
    }

    let cancelled = false

    const request =
      kind === 'poll'
        ? supabase.rpc('get_poll_results', { p_poll_id: key })
        : supabase.rpc('open_poll_results', { p_token: key })

    request.then(({ data, error: rpcError }) => {
      // Remembered whether or not this component still wants it: the answer
      // is about the poll, not about who asked.
      if (!rpcError) remember(rpc, key, data)
      if (cancelled) return
      if (rpcError) setError(rpcError.message)
      else setResults(data as PollResults)
    })

    return () => {
      cancelled = true
    }
  }, [kind, key, rpc])

  if (error) {
    return (
      <Text c="red" size="sm">
        {error}
      </Text>
    )
  }

  if (!results) return <ResultsSkeleton />

  const nameById = new Map(results.options.map((o) => [o.id, o.name]))
  const maxScore = Math.max(1, ...results.options.map((o) => o.total_score))

  return (
    <Stack gap="lg">
      {/* Turnout is reported once, by the participation card below the
          results, and not again here: the same two numbers stated twice on
          one screen read as two different facts that happen to agree. What
          is left is the one thing that card cannot say -- that the numbers
          are smaller than they were going to be. */}
      {results.closed_early && (
        <Text size="sm" c="dimmed">
          Voting was closed early, so these results count the ballots cast up to that point.
        </Text>
      )}

      {results.winner_id && (
        <Card withBorder bg="var(--mantine-color-green-light)">
          <Text fw={700} size="lg">
            Winner: {nameById.get(results.winner_id)}
          </Text>
        </Card>
      )}
      {!results.winner_id && results.finalists.length === 2 && (
        <Card withBorder bg="var(--mantine-color-orange-light)">
          <Text fw={700} size="lg">
            No winner — a genuine tie
          </Text>
        </Card>
      )}

      <Stack gap={4}>
        <Title order={4}>Score round</Title>
        <Stack gap="xs">
          {results.options.map((o) => (
            <div key={o.id}>
              <Group justify="space-between" mb={2} wrap="nowrap" gap="xs">
                <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                  <Text size="sm" fw={results.finalists.includes(o.id) ? 700 : 400} truncate>
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
                color={results.finalists.includes(o.id) ? 'blue' : 'gray'}
              />
            </div>
          ))}
        </Stack>
      </Stack>

      {results.tiebreaks.length > 0 && (
        <Stack gap="sm">
          <Title order={4}>Tie-break{results.tiebreaks.length > 1 ? 's' : ''}</Title>
          {results.tiebreaks.map((tb, i) => (
            <Card withBorder key={i} p="sm">
              <Stack gap="xs">
                <Text size="sm">
                  <strong>{tb.tied.map((t) => t.name).join(' and ')}</strong> tied at {tb.tied_at}{' '}
                  pts for {tb.slots === 1 ? 'the last runoff slot' : `${tb.slots} runoff slots`}.
                  STAR settles this before the runoff:
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
                          {r.name}: {r.value} {r.value === 1 ? 'five-star vote' : 'five-star votes'}
                        </Text>
                      ))
                    )}
                  </Stack>
                ))}

                <Text size="sm" c={tb.resolved_by === 'random' ? 'orange' : undefined}>
                  {tb.resolved_by === 'random'
                    ? `Still tied after every rule — ${tb.advanced
                        .map((a) => a.name)
                        .join(', ')} advanced by random selection.`
                    : `${tb.advanced.map((a) => a.name).join(', ')} advanced on ${
                        tb.resolved_by === 'head_to_head'
                          ? 'head-to-head preference'
                          : 'five-star votes'
                      }.`}
                </Text>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}

      {results.runoff && results.finalists.length === 2 && (
        <Stack gap={4}>
          <Title order={4}>Automatic runoff round</Title>
          <Text size="sm">
            {nameById.get(results.finalists[0])}: {voters(results.runoff.prefers_a)} preferred
          </Text>
          <Text size="sm">
            {nameById.get(results.finalists[1])}: {voters(results.runoff.prefers_b)} preferred
          </Text>
          <Text size="sm" c="dimmed">
            {voters(results.runoff.ties)} scored both finalists equally.
          </Text>
          {results.runoff.resolved_by === 'higher_score' && (
            <Text size="sm">
              The runoff tied, so it went to {nameById.get(results.winner_id ?? '')} on the higher
              score-round total — the first tie-break for a tied runoff.
            </Text>
          )}
          {results.runoff.resolved_by === 'five_star_votes' && (
            <>
              <Text size="sm">
                The runoff tied and both finalists have identical score totals, so it went to{' '}
                {nameById.get(results.winner_id ?? '')} on five-star votes — the same rule that
                settles a tie in the score round.
              </Text>
              <Text size="sm" c="dimmed">
                {nameById.get(results.finalists[0])}: {results.runoff.five_stars_a} ·{' '}
                {nameById.get(results.finalists[1])}: {results.runoff.five_stars_b}
              </Text>
            </>
          )}
          {results.runoff.resolved_by === 'unresolved' && (
            <Text size="sm" c="orange">
              The runoff tied, both finalists have identical score totals, and both were given five
              stars on the same number of ballots, so there is no winner.
            </Text>
          )}
        </Stack>
      )}

      <FullRanking results={results} />
    </Stack>
  )
}

/**
 * The head-to-head tie-break, in the units the ballots were cast in.
 *
 * The rule counts matchups: every option in the tied group is compared with
 * every other, one pair at a time, and the option more voters scored higher
 * wins that pair. Reporting only the totals produced the least useful line
 * this page has ever shown -- two options tied for one runoff slot meet
 * exactly once, and if that meeting is level they have won nothing, so the
 * step read "0 matchups won" twice and left the reader to guess whether that
 * meant a tie, an error, or a rule that had not run.
 *
 * So a two-option tie is reported as the one comparison it actually is,
 * in the same words the runoff below uses for the same arithmetic, and the
 * word "matchup" does not appear at all. A larger group keeps the totals --
 * with three options they are the point, since the rule is asking which one
 * beat the most others -- and shows the pairs they were counted from
 * underneath.
 */
function HeadToHead({ step }: { step: TiebreakStep }) {
  const matchups = step.matchups

  // The built app ships on push while migrations land when they merge, so a
  // browser can hold this code against a star_round that does not send the
  // pairs yet. Fall back to the totals rather than showing nothing.
  if (!matchups?.length) {
    return (
      <>
        {step.results.map((r) => (
          <Text key={r.id} size="sm" c="dimmed" pl="md">
            {r.name}: {r.value} {r.value === 1 ? 'matchup won' : 'matchups won'}
          </Text>
        ))}
      </>
    )
  }

  if (matchups.length === 1) {
    const m = matchups[0]
    return (
      <Stack gap={2} pl="md">
        <Text size="sm" c="dimmed">
          {m.a_name}: {voters(m.prefers_a)} preferred it
        </Text>
        <Text size="sm" c="dimmed">
          {m.b_name}: {voters(m.prefers_b)} preferred it
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

/** One pair of the tied group, and which way its voters went. */
function matchupLine(m: Matchup): string {
  const equal = m.prefers_a === m.prefers_b
  const [ahead, behind, won, lost] =
    m.prefers_a >= m.prefers_b
      ? [m.a_name, m.b_name, m.prefers_a, m.prefers_b]
      : [m.b_name, m.a_name, m.prefers_b, m.prefers_a]

  return equal
    ? `${m.a_name} vs ${m.b_name} — ${voters(won)} each, so neither wins it`
    : `${ahead} vs ${behind} — ${voters(won)} to ${lost}`
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
 * showing nothing at all on the options that never had one -- which is
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
          <InfoIcon />
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

function InfoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.5" />
    </svg>
  )
}
