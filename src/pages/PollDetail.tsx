import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Badge, Button, Card, Group, Progress, Stack, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { pollTopic, useLiveStream } from '../lib/useLiveStream'
import { useWinner } from '../lib/useWinner'
import { voterKeyFor } from '../lib/voterKey'
import { useBallotOrder } from '../lib/ballotOrder'
import { Ballots } from '../components/Ballots'
import { CollectOptions } from '../components/CollectOptions'
import { CreatorControls } from '../components/CreatorControls'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { OptionDescription } from '../components/OptionDescription'
import { NextQuestion } from '../components/NextQuestion'
import { PollHeading } from '../components/PollHeading'
import { QuestionStrip } from '../components/QuestionStrip'
import { RetentionNote } from '../components/RetentionNote'
import { PollPageSkeleton } from '../components/Skeletons'
import { StarRating } from '../components/StarRating'
import { countBadge } from '../lib/badgeColors'
import { Respondents } from '../components/Respondents'
import { Results } from '../components/Results'
import type { GroupQuestion, OpenPollView, Poll, PollOption, PollStatus } from '../lib/types'

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
  // The poll's other questions, when it asks more than one. Read alongside
  // the poll rather than on the live tick: which questions a poll asks is
  // fixed at creation, like everything else about it, so the only part of
  // this that moves is which of them this reader has answered — and that
  // moves when they vote, which re-reads the page anyway.
  const [questions, setQuestions] = useState<GroupQuestion[]>([])
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
  // The scores on this reader's own ballot while they are changing it, or
  // null when they are not. Read from the database at the moment they ask
  // rather than alongside the poll: almost nobody changes their vote, and a
  // poll page should still cost what it always did to open.
  const [revising, setRevising] = useState<Record<string, number> | null>(null)
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

    const [pollRes, optionsRes, statusRes, groupRes] = await Promise.all([
      supabase.from('polls').select('*').eq('id', pollId).single(),
      supabase.from('candidates').select('*').eq('poll_id', pollId).order('sort_order'),
      supabase.rpc('poll_status', { p_poll_id: pollId }).single(),
      supabase.rpc('poll_group', { p_poll_id: pollId }),
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
    // A failure here is swallowed rather than shown: a browser running ahead
    // of the migration that adds poll_group() gets no strip, and a poll with
    // no strip is a poll of one question — which every poll was until now.
    setQuestions(groupRes.error ? [] : ((groupRes.data as GroupQuestion[]) ?? []))

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
    // Navigating from one poll to another remounts nothing, so a ballot
    // half-changed in the poll being left would otherwise turn up on the
    // poll being arrived at, scored against somebody else's options.
    setRevising(null)
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
  const { winner, pending: awaitingWinner } = useWinner(pollId, status?.results_available === true)

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

  // And a ballot that stops existing takes the form changing it with it: the
  // creator can clear every vote in the poll while somebody is part-way
  // through. Same shape as the effect above and there for the same reason —
  // left set, it would put scores from a deleted ballot back on screen the
  // moment this reader voted again.
  const hasVoted = status?.voted === true
  useEffect(() => {
    if (!hasVoted) setRevising(null)
  }, [hasVoted])

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
  // The question after this one, when there is one. `questions` is empty on a
  // poll that asks a single question, so this is null there and nothing about
  // the page changes.
  const here = questions.findIndex((question) => question.id === poll.id)
  const nextQuestion = here >= 0 && here < questions.length - 1 ? questions[here + 1] : null
  // Whether this reader has finished with this question, and so whether the
  // way on is the obvious thing to offer. An open poll answers for the browser
  // holding the key, an invite poll for the account.
  const answeredHere = isOpen ? view?.voted === true : status.voted
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
          awaitingWinner,
        }}
      />

      {/* Where in the poll this question sits, and the way to the rest of
          it. Renders nothing at all on a poll that asks one question, which
          is what keeps every existing poll looking exactly as it did. */}
      <QuestionStrip
        questions={questions.map((question) => ({
          key: question.id,
          position: question.question_position,
          title: question.question_title,
          answered: question.voted,
        }))}
        current={poll.id}
        hrefFor={(id) => `/polls/${id}`}
      />

      {/* What this one question asks, above the ballot that answers it. The
          heading above carries the poll's title, which every question in the
          poll shares; this is the part that is only true of this one, so it
          sits with the options rather than with the poll's terms. */}
      {poll.question_title && <Title order={3}>{poll.question_title}</Title>}

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
          {/* Closing acts on the whole poll, so one question of several can
              end with nothing in it while the rest have results. Saying "this
              poll" there would be wrong about the poll and about the question
              alike. */}
          <Text fw={500}>
            {poll.group_id
              ? 'The poll was closed before anyone answered this question, so it has no results.'
              : 'This poll was closed before anyone voted, so there are no results.'}
          </Text>
        </Card>
      ) : status.voted ? (
        /* You have voted and the results are still sealed, which is exactly
           the window a vote can be changed in — this branch is only reached
           when results_available and is_closed are both false, so the gate
           the database applies is the gate that decides what renders here.
           A ballot arriving from someone else while this is open takes the
           window away by moving the page on to the results, and the form
           goes with it. */
        revising ? (
          <VoteForm
            poll={poll}
            options={options}
            initial={revising}
            onVoted={() => {
              setRevising(null)
              load()
            }}
            onCancel={() => setRevising(null)}
          />
        ) : (
          <Waiting status={status} pollId={poll.id} onRevise={setRevising} />
        )
      ) : (
        /* Keyed like the open-poll panel, and for the same reason: a
           correction to the option list invalidates a half-filled ballot,
           and remounting is what discards it. */
        <VoteForm key={refreshKey} poll={poll} options={options} onVoted={load} />
      )}

      {/* The way on, once this question is behind them. The strip at the top
          can already reach every question; this is the one that is where a
          voter is looking at the moment they finish a ballot. */}
      {nextQuestion && answeredHere && (
        <NextQuestion title={nextQuestion.question_title} href={`/polls/${nextQuestion.id}`} />
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
          questions={questions}
          editingOptions={editingOptions && editable}
          onEditOptions={setEditingOptions}
          onChange={reloadAll}
        />
      )}

      {/* Last thing on the page, and the creator's alone: it is a date to
          act on, and Duplicate — the only act there is — is a button nobody
          else has. See RetentionNote. */}
      {isCreator && <RetentionNote expiresAt={status.expires_at} />}
    </Stack>
  )
}

/**
 * Your vote is in and the group is still voting — which is also the whole of
 * the window in which you may change it.
 *
 * The card says so in the same breath as it says the results unlock on their
 * own, because those two facts are one fact: the moment the last invitee
 * votes is the moment the standings are on screen, and a vote that could be
 * changed after that would be a vote changed against a tally its voter had
 * read. There is no "until voting closes" here to offer, and saying there was
 * would be a promise this page breaks for whoever votes last.
 */
function Waiting({
  status,
  pollId,
  onRevise,
}: {
  status: PollStatus
  pollId: string
  /** The ballot came back: hand it to the page, which puts the form up. */
  onRevise: (scores: Record<string, number>) => void
}) {
  const [loading, setLoading] = useState(false)
  const pct = status.invited_count === 0 ? 0 : (status.voted_count / status.invited_count) * 100

  async function handleRevise() {
    setLoading(true)
    const { data, error } = await supabase.rpc('poll_ballot_scores', { p_poll_id: pollId })
    setLoading(false)

    // The one thing that can realistically have gone wrong is that the last
    // invitee voted while this card was on screen, so the results are out and
    // the ballot is no longer anybody's to change. Say what the database
    // said; the next live tick replaces this card with the results anyway.
    if (error) {
      notifications.show({ message: error.message, color: 'red' })
      return
    }
    onRevise((data as Record<string, number>) ?? {})
  }

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
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 220 }}>
            Results unlock automatically once everyone invited has voted. You can change your vote
            until then.
          </Text>
          <Button variant="light" onClick={handleRevise} loading={loading}>
            Edit vote
          </Button>
        </Group>
      </Stack>
    </Card>
  )
}

/**
 * The ballot for an invite poll, whether it is being filled in for the first
 * time or filled in again.
 *
 * Submitting re-reads the poll rather than leaving it. A vote is not the end
 * of anybody's interest in a poll, the results are, and this page is
 * where they arrive, on its own, as the rest of the group votes. Being sent
 * back to the list threw that away and made the poll something you had to
 * find your way back to.
 *
 * One form for both jobs, because they are the same job: the second time
 * around the stars start where the voter left them instead of at zero, and
 * the scores go to `revise_ballot` instead of `submit_ballot`. A ballot you
 * are changing that looked or behaved unlike the ballot you cast would be two
 * things to learn rather than one.
 */
function VoteForm({
  poll,
  options,
  initial,
  onVoted,
  onCancel,
}: {
  poll: Pick<Poll, 'id'>
  options: PollOption[]
  /** The scores already on this voter's ballot; absent when casting a new one. */
  initial?: Record<string, number>
  /** The ballot is in: re-read the poll so this page becomes the wait. */
  onVoted: () => void
  /** Offered only when changing a vote; leaves the ballot as it stands. */
  onCancel?: () => void
}) {
  const pollId = poll.id
  const revising = initial !== undefined
  // Shown in this browser's own order rather than the creator's; see
  // lib/ballotOrder.ts. The scores below are keyed by option id, so this
  // changes what the voter reads and nothing about what they send.
  const ballot = useBallotOrder(options)
  const [values, setValues] = useState<Record<string, number>>(initial ?? {})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setScore(optionId: string, score: number) {
    setValues((prev) => ({ ...prev, [optionId]: score }))
  }

  async function handleSubmit() {
    setError(null)
    setSubmitting(true)
    try {
      const payload = ballot.map((o) => ({
        candidate_id: o.id,
        score: values[o.id] ?? 0,
      }))
      const { error: rpcError } = await supabase.rpc(revising ? 'revise_ballot' : 'submit_ballot', {
        p_poll_id: pollId,
        p_scores: payload,
      })
      if (rpcError) throw rpcError
      notifications.show({ message: revising ? 'Vote updated' : 'Vote submitted', color: 'green' })
      onVoted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit vote.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Stack gap="md">
      {ballot.map((option) => (
        <Card key={option.id} withBorder>
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <div style={{ minWidth: 0 }}>
              <Text fw={500}>{option.name}</Text>
              {option.description && <OptionDescription description={option.description} />}
            </div>
            <StarRating
              label={`Score for ${option.name}`}
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
        {onCancel && (
          <Button variant="subtle" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button onClick={handleSubmit} loading={submitting}>
          {revising ? 'Save changes' : 'Submit vote'}
        </Button>
      </Group>
    </Stack>
  )
}
