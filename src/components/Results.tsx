import { useEffect, useState } from 'react'
import { Badge, Card, Center, Group, Loader, Progress, Stack, Text, Title } from '@mantine/core'
import { supabase } from '../lib/supabase'
import type { PollResults } from '../lib/types'

/**
 * Which tally endpoint to read. Both return the same shape — the split is
 * only about how the caller proves it's allowed to see it: a session for
 * invite polls, the share token for open ones.
 */
export type ResultsSource = { kind: 'poll'; pollId: string } | { kind: 'token'; token: string }

export function Results({ source }: { source: ResultsSource }) {
  const [results, setResults] = useState<PollResults | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Flattened to primitives so the dependency list is complete without
  // depending on a fresh object identity every render.
  const kind = source.kind
  const key = source.kind === 'poll' ? source.pollId : source.token

  useEffect(() => {
    let cancelled = false

    const request =
      kind === 'poll'
        ? supabase.rpc('get_poll_results', { p_poll_id: key })
        : supabase.rpc('open_poll_results', { p_token: key })

    request.then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) setError(rpcError.message)
      else setResults(data as PollResults)
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

  if (!results) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    )
  }

  const nameById = new Map(results.options.map((o) => [o.id, o.name]))
  const maxScore = Math.max(1, ...results.options.map((o) => o.total_score))

  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        {results.mode === 'open'
          ? // Open polls have no invite list, so a participation rate would
            // be meaningless — there's no denominator.
            `${results.voter_count} ${results.voter_count === 1 ? 'person' : 'people'} voted`
          : `${results.voter_count} of ${results.invited_count} ${
              results.invited_count === 1 ? 'invited voter' : 'invited voters'
            } participated`}
        {results.closed_early && ' — voting was closed early'}
      </Text>

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
                <Text size="sm" fw={results.finalists.includes(o.id) ? 700 : 400} truncate>
                  {o.name}
                </Text>
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
                  <strong>{tb.tied.map((t) => t.name).join(' and ')}</strong> tied at {tb.tied_at} pts
                  for {tb.slots === 1 ? 'the last runoff slot' : `${tb.slots} runoff slots`}. STAR
                  settles this before the runoff:
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
                      <Badge size="xs" variant="light" color={step.decisive ? 'green' : 'gray'}>
                        {step.decisive ? 'Decisive' : 'Still tied'}
                      </Badge>
                    </Group>
                    {step.results.map((r) => (
                      <Text key={r.id} size="sm" c="dimmed" pl="md">
                        {r.name}: {r.value}{' '}
                        {step.rule === 'head_to_head'
                          ? r.value === 1
                            ? 'matchup won'
                            : 'matchups won'
                          : r.value === 1
                            ? 'five-star vote'
                            : 'five-star votes'}
                      </Text>
                    ))}
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
            {nameById.get(results.finalists[0])}: {results.runoff.prefers_a} voters preferred
          </Text>
          <Text size="sm">
            {nameById.get(results.finalists[1])}: {results.runoff.prefers_b} voters preferred
          </Text>
          <Text size="sm" c="dimmed">
            {results.runoff.ties} voters scored both finalists equally.
          </Text>
          {results.runoff.resolved_by === 'higher_score' && (
            <Text size="sm">
              The runoff tied, so it went to {nameById.get(results.winner_id ?? '')} on the higher
              score-round total — STAR's rule for a tied runoff.
            </Text>
          )}
          {results.runoff.resolved_by === 'unresolved' && (
            <Text size="sm" c="orange">
              The runoff tied and both finalists have identical score totals, so there is no winner
              under STAR's rules.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  )
}
