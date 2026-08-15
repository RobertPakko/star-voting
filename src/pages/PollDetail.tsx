import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Progress,
  Rating,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { CreatorControls } from '../components/CreatorControls'
import type { Poll, PollOption, PollResults, PollStatus } from '../lib/types'

export function PollDetail() {
  const { pollId } = useParams<{ pollId: string }>()
  const { session } = useAuth()
  const [poll, setPoll] = useState<Poll | null>(null)
  const [options, setOptions] = useState<PollOption[]>([])
  const [status, setStatus] = useState<PollStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!pollId) return
    setError(null)

    const [pollRes, optionsRes, statusRes] = await Promise.all([
      supabase.from('polls').select('*').eq('id', pollId).single(),
      supabase.from('candidates').select('*').eq('poll_id', pollId).order('sort_order'),
      supabase.rpc('poll_status', { p_poll_id: pollId }).single(),
    ])

    if (pollRes.error || statusRes.error) {
      setError((pollRes.error ?? statusRes.error)!.message)
      setLoading(false)
      return
    }

    setPoll(pollRes.data as Poll)
    setOptions((optionsRes.data as PollOption[]) ?? [])
    setStatus((statusRes.data as PollStatus) ?? null)
    setLoading(false)
  }, [pollId])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    )
  }

  if (error || !poll || !status) {
    return (
      <Text c="red" ta="center">
        {error ?? 'Poll not found.'}
      </Text>
    )
  }

  const isCreator = poll.created_by === session?.user.id

  return (
    <Stack maw={640} mx="auto" gap="lg">
      <Stack gap={4}>
        <Group gap="xs">
          <Title order={2}>{poll.title}</Title>
          {status.is_closed && (
            <Badge color="gray" variant="light">
              Closed
            </Badge>
          )}
        </Group>
        {poll.description && <Text c="dimmed">{poll.description}</Text>}
      </Stack>

      {status.results_available ? (
        <Results pollId={poll.id} />
      ) : status.is_closed ? (
        <Card withBorder>
          <Text fw={500}>This poll was closed before anyone voted, so there are no results.</Text>
        </Card>
      ) : status.voted ? (
        <Waiting status={status} />
      ) : (
        <VoteForm pollId={poll.id} options={options} />
      )}

      {isCreator && <CreatorControls pollId={poll.id} status={status} onChange={load} />}
    </Stack>
  )
}

function Waiting({ status }: { status: PollStatus }) {
  const pct = status.invited_count === 0 ? 0 : (status.voted_count / status.invited_count) * 100
  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text fw={500}>Your vote is in. Waiting on the rest of the group.</Text>
          <Badge variant="light">
            {status.voted_count}/{status.invited_count} voted
          </Badge>
        </Group>
        <Progress value={pct} />
        <Text size="sm" c="dimmed">
          Results unlock automatically once everyone invited has voted.
        </Text>
      </Stack>
    </Card>
  )
}

function VoteForm({ pollId, options }: { pollId: string; options: PollOption[] }) {
  const navigate = useNavigate()
  const [values, setValues] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setScore(optionId: string, score: number) {
    setValues((prev) => ({ ...prev, [optionId]: score }))
  }

  async function handleSubmit() {
    setError(null)
    setSubmitting(true)
    try {
      const payload = options.map((o) => ({
        candidate_id: o.id,
        score: values[o.id] ?? 0,
      }))
      const { error: rpcError } = await supabase.rpc('submit_ballot', {
        p_poll_id: pollId,
        p_scores: payload,
      })
      if (rpcError) throw rpcError
      notifications.show({ message: 'Vote submitted', color: 'green' })
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit vote.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Score each option from 0 (worst) to 5 (best). Unscored options count as 0.
      </Text>
      {options.map((option) => (
        <Card key={option.id} withBorder>
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <div style={{ minWidth: 0 }}>
              <Text fw={500}>{option.name}</Text>
              {option.description && (
                <Text size="sm" c="dimmed">
                  {option.description}
                </Text>
              )}
            </div>
            <Rating
              count={5}
              value={values[option.id] ?? 0}
              onChange={(v) => setScore(option.id, v)}
            />
          </Group>
        </Card>
      ))}

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}

      <Group justify="flex-end">
        <Button onClick={handleSubmit} loading={submitting}>
          Submit vote
        </Button>
      </Group>
    </Stack>
  )
}

function Results({ pollId }: { pollId: string }) {
  const [results, setResults] = useState<PollResults | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    supabase.rpc('get_poll_results', { p_poll_id: pollId }).then(({ data, error: rpcError }) => {
      if (cancelled) return
      if (rpcError) setError(rpcError.message)
      else setResults(data as PollResults)
    })
    return () => {
      cancelled = true
    }
  }, [pollId])

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
        {results.voter_count} of {results.invited_count}{' '}
        {results.invited_count === 1 ? 'invited voter' : 'invited voters'} participated
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
