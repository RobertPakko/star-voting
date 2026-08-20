import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Badge, Button, Card, Group, Progress, Rating, Stack, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { pollTopic, useLiveStream } from '../lib/useLiveStream'
import { useWinner } from '../lib/useWinner'
import { voterKeyFor } from '../lib/voterKey'
import { Ballots } from '../components/Ballots'
import { CollectOptions } from '../components/CollectOptions'
import { CreatorControls } from '../components/CreatorControls'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { OptionDescription } from '../components/OptionDescription'
import { PollHeading } from '../components/PollHeading'
import { RetentionNote } from '../components/RetentionNote'
import { PollPageSkeleton } from '../components/Skeletons'
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
  // Whether the creator is correcting the option list, which stands in for
  // the ballot while they are. Owned here rather than in CreatorControls
  // because it is this page that swaps one for the other; the button that
  // sets it lives down there with the rest of what the creator does to the
  // poll.
  const [editingOptions, setEditingOptions] = useState(false)
  // Whether the whole poll has been read yet. This page has two reads — the
  // whole poll once, and the parts that move on every signal after that —
  // and the socket cannot tell them apart, so something has to remember
  // which one is next. A ref rather than state because the answer is needed
  // during a read rather than at the next render: two signals arriving
  // together must not both decide they are the first.
  const loadedOnce = useRef(false)

  const load = useCallback(async () => {
    if (!pollId) return true
    setError(null)

    const [pollRes, optionsRes, statusRes] = await Promise.all([
      supabase.from('polls').select('*').eq('id', pollId).single(),
      supabase.from('candidates').select('*').eq('poll_id', pollId).order('sort_order'),
      supabase.rpc('poll_status', { p_poll_id: pollId }).single(),
    ])

    if (pollRes.error || statusRes.error) {
      setError((pollRes.error ?? statusRes.error)!.message)
      setLoading(false)
      return false
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
        return false
      }
      setView(data as OpenPollView)
    }

    loadedOnce.current = true
    setLoading(false)
    return true
  }, [pollId])

  // Whether this page has to re-read the option list on the live tick. Open
  // polls get theirs inside open_poll_view, so this is about invite polls.
  //
  // The window is "no votes yet", which is exactly the window the database
  // lets the list move in: a poll collecting its options takes suggestions
  // from everyone in it, and a poll past that stage still takes corrections
  // from its creator, who may be making them in another tab. It is a hair
  // wider than either stage on purpose — a suggestion landing between the
  // last tick and the creator opening the poll would otherwise leave a voter
  // scoring a ballot one option short of the one submit_ballot expects.
  // guard_options_frozen takes over from the first ballot on.
  const optionsMayMove = poll?.mode === 'invite' && status?.voted_count === 0

  // The live tick, deliberately narrower than load(): a poll's title and
  // settings are frozen at creation, so what can change while someone
  // watches is the counts, the options of a poll collecting them, and
  // whether it has moved on to voting or closed.
  const refresh = useCallback(async () => {
    if (!pollId) return true
    // Bumped before the requests rather than after, so the roster below
    // asks at the same moment this does and the two agree on screen.
    setLiveTick((t) => t + 1)

    const token = poll?.mode === 'open' ? poll.public_token : null
    const [statusRes, viewRes, optionsRes] = await Promise.all([
      supabase.rpc('poll_status', { p_poll_id: pollId }).single(),
      token
        ? supabase.rpc('open_poll_view', { p_token: token, p_voter_key: voterKeyFor(token) })
        : null,
      optionsMayMove
        ? supabase.from('candidates').select('*').eq('poll_id', pollId).order('sort_order')
        : null,
    ])

    // A refresh that fails changes nothing on screen: the page keeps the
    // copy it has and is asked again shortly. Replacing a poll that has been
    // working for ten minutes with an error message, because one request
    // lost a race with a flaky connection, would be much worse than being a
    // few seconds out of date.
    if (!statusRes.error && statusRes.data) setStatus(statusRes.data as PollStatus)
    if (viewRes && !viewRes.error && viewRes.data) setView(viewRes.data as OpenPollView)
    if (optionsRes && !optionsRes.error && optionsRes.data)
      setOptions(optionsRes.data as PollOption[])

    // The status is what every other part of this page is derived from, so
    // it decides whether this counts as a read at all. The other two are
    // allowed to have missed: an option list that arrives one signal late
    // costs nothing, and a poll can only be waiting on one of them anyway.
    return !statusRes.error
  }, [pollId, poll?.mode, poll?.public_token, optionsMayMove])

  // What a signal on this poll means, which depends on whether this page has
  // ever read it: the whole poll the first time, and only the parts that can
  // move on every one after that. Navigating from one poll to another
  // remounts nothing, so the flag is cleared alongside the poll it describes.
  const onSignal = useCallback(async () => {
    if (loadedOnce.current) return refresh()
    return load()
  }, [load, refresh])

  useEffect(() => {
    loadedOnce.current = false
  }, [pollId])

  // Nothing about a closed poll changes again, and a poll whose results are
  // out has taken its last vote either way; so the watching stops. Before the
  // first read there is nothing to stop for — that read is what the
  // subscription is for.
  const live = !status || (!status.is_closed && !status.results_available)
  const liveStatus = useLiveStream(pollId ? [pollTopic(pollId)] : [], onSignal, { enabled: live })

  // For the state badge beside the title. Almost always already known: the
  // list this poll was opened from asked the same question through the same
  // cache.
  const winner = useWinner(pollId, status?.results_available === true)

  // Close and reset invalidate a ballot half-filled in the open-poll panel,
  // so they remount it as well as re-reading the poll. A vote doesn't: the
  // ballot it was filling in is gone either way, and a remount would only
  // throw away a panel that is already showing the right thing.
  const reloadAll = useCallback(() => {
    setRefreshKey((k) => k + 1)
    load()
  }, [load])

  // Whether the creator may correct the option list as things stand: their
  // own poll, past the collecting stage, still open, and nobody has voted.
  // The same terms the database allows it on; see
  // 0028_creator_edits_options.sql.
  //
  // Computed up here, above the early returns, so the effect below can watch
  // it. A vote arriving while the editor is open has to put the ballot back,
  // and closing the editor rather than merely hiding it is what keeps it
  // from springing open again if those votes are later cleared.
  const editable =
    !!poll &&
    !!status &&
    poll.created_by === session?.user.id &&
    !status.soliciting &&
    !status.is_closed &&
    status.voted_count === 0

  useEffect(() => {
    if (!editable) setEditingOptions(false)
  }, [editable])

  // The shape of the page that is coming: a title, the poll's terms, and
  // the cards of a ballot. See the note in Skeletons.tsx.
  if (loading) return <PollPageSkeleton />

  if (error || !poll || !status) {
    return (
      <Text c="red" ta="center">
        {error ?? 'Poll not found.'}
      </Text>
    )
  }

  const isCreator = poll.created_by === session?.user.id
  const isOpen = poll.mode === 'open'
  // One option list for this page. An open poll's arrives inside its view,
  // which is what its ballot is scored from; every other poll's is the table
  // read directly. The heading counts it and the option editor edits it, and
  // neither should have to know which poll it is looking at.
  const optionList = isOpen ? (view?.options ?? []) : options

  return (
    <Stack maw={640} mx="auto" gap="lg">
      <LiveConnectionNotice status={liveStatus} />

      {/* The same heading a poll wears on the list it was opened from, down
          to who created it and the order the parts come in; see
          PollHeading. */}
      <PollHeading
        title={poll.title}
        description={poll.description}
        createdBy={isCreator ? 'you' : poll.created_by_email}
        mode={poll.mode}
        showVoters={poll.show_voters}
        showBallots={poll.show_ballots}
        turnout={{
          soliciting: status.soliciting,
          mode: poll.mode,
          votedCount: status.voted_count,
          invitedCount: status.invited_count,
          optionCount: optionList.length,
        }}
        state={{
          soliciting: status.soliciting,
          resultsAvailable: status.results_available,
          closed: status.is_closed,
          winner,
        }}
      />

      {/* The creator's correction to an option list that is already a ballot,
          in place of that ballot while it is open. It replaces the ballot
          rather than sitting beside it because they are two readings of one
          list, and a poll with no votes in it has no ballot anybody is
          part-way through. See 0028_creator_edits_options.sql for when this
          is allowed at all. */}
      {editingOptions && editable ? (
        <CollectOptions
          source={{ kind: 'creator', pollId: poll.id }}
          options={optionList}
          isCreator
          footer={
            <Group justify="space-between" wrap="wrap" gap="sm">
              <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
                Nobody has voted yet, so options can still be updated.
              </Text>
              <Button variant="light" onClick={() => setEditingOptions(false)}>
                Done
              </Button>
            </Group>
          }
          onChanged={reloadAll}
        />
      ) : /* Open polls are voted through the same anon RPCs the public route
             uses, so the creator votes in their own poll exactly as everyone
             else does; one code path, one set of rules. */
      isOpen ? (
        view && (
          // Keyed so a close or a reset remounts it; see where refreshKey
          // is declared. A live refresh only replaces the view prop, which
          // leaves a half-filled ballot inside the panel alone.
          <OpenPollPanel
            key={refreshKey}
            token={poll.public_token!}
            view={view}
            isCreator={isCreator}
            onChanged={load}
          />
        )
      ) : status.soliciting ? (
        /* No ballot yet: the poll is a list everyone in it can add to, and
           the creator decides when it becomes a ballot. */
        <CollectOptions
          source={{ kind: 'poll', pollId: poll.id }}
          options={options}
          isCreator={isCreator}
          footer={
            <Text size="sm" c="dimmed">
              {isCreator
                ? 'Voting hasn’t started. Everyone can add options until you open the poll.'
                : 'Voting hasn’t started. Everyone can add options until the poll’s creator opens the poll.'}
            </Text>
          }
          onChanged={load}
        />
      ) : status.results_available ? (
        <Stack gap="lg">
          <Results source={{ kind: 'poll', pollId: poll.id }} pollId={poll.id} />
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
        /* Keyed like the open-poll panel, and for the same reason: a
           correction to the option list invalidates a half-filled ballot,
           and remounting is what discards it. */
        <VoteForm key={refreshKey} poll={poll} options={options} onVoted={load} />
      )}

      {/* Held back until you have voted, for the reasons set out where the
          open-poll panel does the same; including the two exemptions. The
          creator is exempt twice over: they decide when to close, and this
          is also where they manage the invite list. A poll whose results are
          out is exempt because the embargo exists to keep a roster away from
          somebody still holding a ballot, and there are no ballots left to
          hold. It is also where turnout is reported now that the results
          above it no longer state it themselves. */}
      {!isOpen && (status.voted || isCreator || status.results_available) && (
        <Stack gap="sm">
          <Title order={4}>Voters</Title>
          <Respondents
            pollId={poll.id}
            isCreator={isCreator}
            showVoters={poll.show_voters}
            status={status}
            liveTick={liveTick}
            onChange={reloadAll}
          />
        </Stack>
      )}

      {/* The share link is inside Manage poll now; see the note there. */}
      {isCreator && (
        <CreatorControls
          poll={poll}
          status={status}
          optionCount={optionList.length}
          editingOptions={editingOptions && editable}
          onEditOptions={setEditingOptions}
          onChange={reloadAll}
        />
      )}

      {/* Last thing on the page, for everyone who can see the poll rather
          than its creator alone: a voter's ballot is in here too, and the
          result they came back to read goes on the same day. Only the
          creator is pointed at Duplicate, since only they have it. */}
      <RetentionNote expiresAt={status.expires_at} canDuplicate={isCreator} />
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

/**
 * The ballot for an invite poll.
 *
 * Submitting re-reads the poll rather than leaving it. A vote is not the end
 * of anybody's interest in a poll, the results are, and this page is
 * where they arrive, on its own, as the rest of the group votes. Being sent
 * back to the list threw that away and made the poll something you had to
 * find your way back to.
 */
function VoteForm({
  poll,
  options,
  onVoted,
}: {
  poll: Pick<Poll, 'id'>
  options: PollOption[]
  /** The ballot is in: re-read the poll so this page becomes the wait. */
  onVoted: () => void
}) {
  const pollId = poll.id
  const [values, setValues] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setScore(optionId: string, score: number) {
    // Mantine's Rating only applies allowClear (re-tap-to-zero) on the click
    // path; on touch it calls onChange straight from touch coordinates and
    // suppresses the click that would carry the clear logic. Reimplement the
    // clear here so tapping the already-selected star still zeroes it out.
    setValues((prev) => ({
      ...prev,
      [optionId]: score !== 0 && (prev[optionId] ?? 0) === score ? 0 : score,
    }))
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
      onVoted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit vote.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Score each option from 0 (worst) to 5 (best). Unscored options count as 0, and clicking the
        star you picked returns an option to 0.
      </Text>
      {options.map((option) => (
        <Card key={option.id} withBorder>
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <div style={{ minWidth: 0 }}>
              <Text fw={500}>{option.name}</Text>
              {option.description && <OptionDescription description={option.description} />}
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
