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
import { useLiveRefresh } from '../lib/useLiveRefresh'
import { voterKeyFor } from '../lib/voterKey'
import { Ballots } from '../components/Ballots'
import { CreatorControls } from '../components/CreatorControls'
import { LiveIndicator } from '../components/LiveIndicator'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { PollTags } from '../components/PollTags'
import { countBadge } from '../lib/badgeColors'
import { Respondents } from '../components/Respondents'
import { Results } from '../components/Results'
import type { OpenPollView, Poll, PollOption, PollStatus } from '../lib/types'

export function PollDetail() {
  const { pollId } = useParams<{ pollId: string }>()
  const { session } = useAuth()
  const [poll, setPoll] = useState<Poll | null>(null)
  const [options, setOptions] = useState<PollOption[]>([])
  const [status, setStatus] = useState<PollStatus | null>(null)
  // An open poll's own view of itself, read through the token RPCs. Owned
  // here rather than inside OpenPollPanel so that one place on this page
  // holds the poll's live state: the tags row, the creator controls and the
  // panel then can never disagree about how many votes are in.
  const [view, setView] = useState<OpenPollView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped only by creator actions, and used as OpenPollPanel's key so it
  // remounts. Closing or resetting invalidates a half-filled ballot in the
  // panel, and remounting is what discards it.
  const [refreshKey, setRefreshKey] = useState(0)
  // Bumped on every live refresh, and watched by <Respondents> so the
  // roster reloads on this page's clock instead of running one of its own.
  // Two timers would drift, and a roster a few seconds ahead of the count
  // sitting above it reads as a bug rather than as a refresh in flight.
  const [liveTick, setLiveTick] = useState(0)

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

    const loaded = pollRes.data as Poll
    setPoll(loaded)
    setOptions((optionsRes.data as PollOption[]) ?? [])
    setStatus((statusRes.data as PollStatus) ?? null)

    if (loaded.mode === 'open' && loaded.public_token) {
      const { data, error: viewError } = await supabase.rpc('open_poll_view', {
        p_token: loaded.public_token,
        p_voter_key: voterKeyFor(loaded.public_token),
      })
      if (viewError) {
        setError(viewError.message)
        setLoading(false)
        return
      }
      setView(data as OpenPollView)
    }

    setLoading(false)
  }, [pollId])

  useEffect(() => {
    load()
  }, [load])

  // The live tick, deliberately narrower than load(): a poll's title,
  // options and settings are frozen at creation, so the only things that
  // can change while someone watches are the counts and whether it closed.
  const refresh = useCallback(async () => {
    if (!pollId) return
    // Bumped before the requests rather than after, so the roster below
    // asks at the same moment this does and the two agree on screen.
    setLiveTick((t) => t + 1)

    const token = poll?.mode === 'open' ? poll.public_token : null
    const [statusRes, viewRes] = await Promise.all([
      supabase.rpc('poll_status', { p_poll_id: pollId }).single(),
      token
        ? supabase.rpc('open_poll_view', { p_token: token, p_voter_key: voterKeyFor(token) })
        : null,
    ])

    // A refresh that fails changes nothing on screen: the page keeps the
    // copy it has and tries again on the next tick. Replacing a poll that
    // has been working for ten minutes with an error message, because one
    // request lost a race with a flaky connection, would be much worse
    // than being five seconds out of date.
    if (!statusRes.error && statusRes.data) setStatus(statusRes.data as PollStatus)
    if (viewRes && !viewRes.error && viewRes.data) setView(viewRes.data as OpenPollView)
  }, [pollId, poll?.mode, poll?.public_token])

  // Nothing about a closed poll changes again, and a poll whose results are
  // out has taken its last vote either way -- so the refreshing stops, and
  // the indicator goes with it. Its absence is the honest signal there:
  // there is nothing left to wait for.
  const live = !!status && !status.is_closed && !status.results_available
  const { paused } = useLiveRefresh(refresh, { enabled: live })

  // Close and reset invalidate a ballot half-filled in the open-poll panel,
  // so they remount it as well as re-reading the poll. A vote doesn't: the
  // ballot it was filling in is gone either way, and a remount would only
  // throw away a panel that is already showing the right thing.
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
        {poll.description && <Text c="dimmed">{poll.description}</Text>}
        {/* All three terms of the poll, at the top, whichever way each is
            set -- people arrive here from a link with no other context. The
            live dot rides the same row: it describes the whole page rather
            than any one number on it, and there is exactly one of it. */}
        <Group justify="space-between" gap="xs">
          <PollTags
            mode={poll.mode}
            showVoters={poll.show_voters}
            showBallots={poll.show_ballots}
            closed={status.is_closed}
          />
          {live && <LiveIndicator paused={paused} />}
        </Group>
      </Stack>

      {/* Open polls are voted through the same anon RPCs the public route
          uses, so the creator votes in their own poll exactly as everyone
          else does -- one code path, one set of rules. */}
      {isOpen ? (
        view && (
          // Keyed so a close or a reset remounts it -- see where refreshKey
          // is declared. A live refresh only replaces the view prop, which
          // leaves a half-filled ballot inside the panel alone.
          <OpenPollPanel
            key={refreshKey}
            token={poll.public_token!}
            view={view}
            isCreator={isCreator}
            onVoted={load}
          />
        )
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
        <Respondents
          pollId={poll.id}
          isCreator={isCreator}
          status={status}
          liveTick={liveTick}
          onChange={reloadAll}
        />
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
          <Badge {...countBadge}>
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

function VoteForm({ poll, options }: { poll: Pick<Poll, 'id'>; options: PollOption[] }) {
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
    </Stack>
  )
}
