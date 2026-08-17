import { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Rating,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { voterKeyFor } from '../lib/voterKey'
import { BallotPrivacy } from './BallotPrivacy'
import { Ballots } from './Ballots'
import { Results } from './Results'
import type { OpenPollView, PollOption } from '../lib/types'

/**
 * The whole voting experience for an open poll, driven by the share token.
 *
 * Used twice: on the public /p/:token route for people who never sign in,
 * and inside the creator's own poll page so they can vote in their own poll
 * without going through the link. Both go through the same anon-callable
 * RPCs, so there is one code path and one set of rules.
 */
export function OpenPollPanel({
  token,
  onChange,
}: {
  token: string
  onChange?: () => void
}) {
  const [view, setView] = useState<OpenPollView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('open_poll_view', {
      p_token: token,
      p_voter_key: voterKeyFor(token),
    })
    if (rpcError) setError(rpcError.message)
    else setView(data as OpenPollView)
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  if (error) {
    return (
      <Text c="red" ta="center">
        {error}
      </Text>
    )
  }

  if (!view) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    )
  }

  function handleVoted() {
    load()
    onChange?.()
  }

  if (view.results_available) {
    return (
      <Stack gap="lg">
        <Results source={{ kind: 'token', token }} />
        {/* Gated in the database on the same terms as the results, so this
            condition only decides whether to ask. */}
        {view.poll.show_ballots && <Ballots source={{ kind: 'token', token }} />}
      </Stack>
    )
  }

  if (view.is_closed) {
    return (
      <Card withBorder>
        <Text fw={500}>This poll was closed before anyone voted, so there are no results.</Text>
      </Card>
    )
  }

  return (
    <Stack gap="md">
      {view.voted ? (
        <Card withBorder>
          <Stack gap="xs">
            <Text fw={500}>
              {view.your_name ? `Your vote is in, ${view.your_name}.` : 'Your vote is in.'}
            </Text>
            <Text size="sm" c="dimmed">
              Results are revealed once the poll's creator closes it, so nobody votes knowing how
              it's going.
            </Text>
          </Stack>
        </Card>
      ) : (
        <OpenBallot
          token={token}
          options={view.options}
          needsName={view.poll.show_voters}
          showBallots={view.poll.show_ballots}
          onVoted={handleVoted}
        />
      )}

      {/* Exactly one place reports participation: the roster when the poll
          names respondents, a bare count when it doesn't. */}
      {view.voters ? (
        <VoterList voters={view.voters} />
      ) : (
        <Card withBorder>
          <Group justify="space-between" gap="xs">
            <Text size="sm" c="dimmed">
              This poll doesn't show who has responded.
            </Text>
            <ResponseCount count={view.voted_count} />
          </Group>
        </Card>
      )}
    </Stack>
  )
}

function ResponseCount({ count }: { count: number }) {
  return (
    <Badge variant="light">
      {count} {count === 1 ? 'response' : 'responses'}
    </Badge>
  )
}

function VoterList({ voters }: { voters: string[] }) {
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Group justify="space-between" gap="xs">
          <Text fw={500} size="sm">
            Voted so far
          </Text>
          <ResponseCount count={voters.length} />
        </Group>
        {voters.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nobody has voted yet.
          </Text>
        ) : (
          <Group gap="xs">
            {voters.map((name) => (
              <Badge key={name} variant="light" color="green">
                {name}
              </Badge>
            ))}
          </Group>
        )}
      </Stack>
    </Card>
  )
}

function OpenBallot({
  token,
  options,
  needsName,
  showBallots,
  onVoted,
}: {
  token: string
  options: PollOption[]
  needsName: boolean
  showBallots: boolean
  onVoted: () => void
}) {
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    setError(null)

    const trimmedName = name.trim()
    if (needsName && !trimmedName) {
      setError('Enter your name so the group can see who has voted.')
      return
    }

    setSubmitting(true)
    const { error: rpcError } = await supabase.rpc('open_poll_submit', {
      p_token: token,
      p_scores: options.map((o) => ({ candidate_id: o.id, score: values[o.id] ?? 0 })),
      p_voter_key: voterKeyFor(token),
      p_voter_name: needsName ? trimmedName : null,
    })
    setSubmitting(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    notifications.show({ message: 'Vote submitted', color: 'green' })
    onVoted()
  }

  return (
    <Stack gap="md">
      {/* Above everything, including the name field: what that name will be
          attached to is exactly what this explains. */}
      <BallotPrivacy mode="open" showVoters={needsName} showBallots={showBallots} />

      <Text size="sm" c="dimmed">
        Score each option from 0 (worst) to 5 (best). Unscored options count as 0.
      </Text>

      {needsName && (
        <TextInput
          label="Your name"
          description={
            showBallots
              ? 'Shown to everyone in the poll, next to the scores on this ballot.'
              : 'Shown to everyone in the poll, so they know whose vote is in.'
          }
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={60}
          required
        />
      )}

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
              onChange={(v) => setValues((prev) => ({ ...prev, [option.id]: v }))}
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
