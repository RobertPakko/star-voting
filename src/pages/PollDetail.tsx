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
import { BallotPrivacy } from '../components/BallotPrivacy'
import { Ballots } from '../components/Ballots'
import { CreatorControls } from '../components/CreatorControls'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { PollTags } from '../components/PollTags'
import { Respondents } from '../components/Respondents'
import { Results } from '../components/Results'
import type { Poll, PollOption, PollStatus } from '../lib/types'

export function PollDetail() {
  const { pollId } = useParams<{ pollId: string }>()
  const { session } = useAuth()
  const [poll, setPoll] = useState<Poll | null>(null)
  const [options, setOptions] = useState<PollOption[]>([])
  const [status, setStatus] = useState<PollStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped only by creator actions, and used as OpenPollPanel's key so it
  // remounts. The panel keeps its own copy of the poll (it reads through the
  // token RPCs, not poll_status), so reloading this page alone would leave
  // it rendering pre-close or pre-reset state.
  const [refreshKey, setRefreshKey] = useState(0)

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

  // Close and reset change what the open-poll panel should be rendering, so
  // they refresh both. A vote doesn't: the panel has already refreshed
  // itself by then, and bumping the key would just refetch it twice.
  const reloadAll = useCallback(() => {
    setRefreshKey((k) => k + 1)
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
  const isOpen = poll.mode === 'open'

  return (
    <Stack maw={640} mx="auto" gap="lg">
      <Stack gap={8}>
        <Title order={2}>{poll.title}</Title>
        {/* All three terms of the poll, at the top, whichever way each is
            set -- people arrive here from a link with no other context. */}
        <PollTags
          mode={poll.mode}
          showVoters={poll.show_voters}
          showBallots={poll.show_ballots}
          closed={status.is_closed}
        />
        {poll.description && <Text c="dimmed">{poll.description}</Text>}
      </Stack>

      {/* Open polls are voted through the same anon RPCs the public route
          uses, so the creator votes in their own poll exactly as everyone
          else does -- one code path, one set of rules. */}
      {isOpen ? (
        // Remounting on refreshKey is the whole refresh mechanism -- see
        // where it's declared. Closing or resetting invalidates any ballot
        // half-filled in the panel anyway, so losing that state is correct.
        <OpenPollPanel
          key={refreshKey}
          token={poll.public_token!}
          isCreator={isCreator}
          onChange={load}
        />
      ) : status.results_available ? (
        <Stack gap="lg">
          <Results source={{ kind: 'poll', pollId: poll.id }} />
          {/* Gated in the database on the same terms as the results, so this
              condition only decides whether to ask. */}
          {poll.show_ballots && <Ballots source={{ kind: 'poll', pollId: poll.id }} />}
        </Stack>
      ) : status.is_closed ? (
        <Card withBorder>
          <Text fw={500}>This poll was closed before anyone voted, so there are no results.</Text>
        </Card>
      ) : status.voted ? (
        <Waiting status={status} />
      ) : (
        <VoteForm poll={poll} options={options} />
      )}

      {/* Held back until you have voted, for the reasons set out where the
          open-poll panel does the same. The creator is exempt twice over:
          they decide when to close, and this is also where they manage the
          invite list. */}
      {!isOpen && (status.voted || isCreator) && (
        <Respondents pollId={poll.id} isCreator={isCreator} status={status} onChange={reloadAll} />
      )}

      {/* The share link is inside Manage poll now -- see the note there. */}
      {isCreator && <CreatorControls poll={poll} status={status} onChange={reloadAll} />}
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

function VoteForm({ poll, options }: { poll: Poll; options: PollOption[] }) {
  const navigate = useNavigate()
  const pollId = poll.id
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
        Score each option from 0 (worst) to 5 (best). Unscored options count as 0, and
        clicking the star you picked returns an option to 0.
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
            {/* 0 is a real score here, not the absence of one, and without
                allowClear it has no reachable target: the 0 hit area is an
                overlay that only wins a click while the score is already 0,
                so a voter who picked any star could never take it back.
                allowClear makes clicking the chosen star again return it. */}
            <Rating
              count={5}
              allowClear
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

      {/* Below the button, not above the options -- see the matching note on
          the open-poll ballot. Still on the same screen, still before
          anything is submitted. */}
      <BallotPrivacy
        mode={poll.mode}
        showVoters={poll.show_voters}
        showBallots={poll.show_ballots}
      />
    </Stack>
  )
}
