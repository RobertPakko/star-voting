import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Center,
  Divider,
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
import { badgeColor, countBadge } from '../lib/badgeColors'
import { Ballots } from './Ballots'
import { Results } from './Results'
import { ShareLink } from './ShareLink'
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
  isCreator = false,
  onChange,
}: {
  token: string
  /** Creators see participation before voting; see where it's rendered. */
  isCreator?: boolean
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
            {/* Offered here and not on the ballot: passing the link on is a
                reasonable thing to want the moment you have finished, and a
                distraction before that. The creator has it in Manage poll
                regardless, so this is not their only route to it. */}
            <Divider my="xs" />
            <ShareLink
              poll={{
                id: view.poll.id,
                title: view.poll.title,
                mode: 'open',
                public_token: token,
              }}
            />
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

      {/* Participation is held back until you have voted: nothing in it helps
          you fill in a ballot, and on a poll that names respondents it is a
          live feed of the arrival order -- which the app otherwise works to
          keep off the published ballots (see the ordering note in AGENTS.md).
          Withholding it until you vote leaves that order visible only to
          people actually in the poll, rather than to anyone holding the link.

          The creator is exempt: the roster is what "close voting now" is
          decided on, and a creator who isn't voting can never earn the view.

          Exactly one place reports participation: the roster when the poll
          names respondents, a bare count when it doesn't. */}
      {(view.voted || isCreator) &&
        (view.voters ? (
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
        ))}
    </Stack>
  )
}

function ResponseCount({ count }: { count: number }) {
  return (
    <Badge {...countBadge}>
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
              <Badge key={name} variant="light" color={badgeColor.done}>
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
  const nameRef = useRef<HTMLInputElement>(null)

  /**
   * Dismissing the on-screen keyboard on a phone does not blur the field it
   * belongs to, and Rating cancels the default action of the tap that picks a
   * star, so focus never moves off the name box on its own. Left alone, every
   * score a voter gives pops the keyboard back up over the ballot. Dropping
   * focus as the tap starts -- before the browser decides whether to re-open
   * the keyboard -- leaves the stars tappable in peace.
   */
  function releaseNameFocus() {
    nameRef.current?.blur()
  }

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
      {needsName && (
        <TextInput
          ref={nameRef}
          label="Your name"
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
            {/* See the note on the invite-poll ballot: without allowClear a
                score of 0 is unreachable once any star is picked. */}
            <Rating
              count={5}
              allowClear
              value={values[option.id] ?? 0}
              onChange={(v) => setValues((prev) => ({ ...prev, [option.id]: v }))}
              onPointerDown={releaseNameFocus}
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
