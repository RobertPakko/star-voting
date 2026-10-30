import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Card, Group, Progress, Stack, Text, Title } from '@mantine/core'
import { PencilSimpleIcon } from '@phosphor-icons/react'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { voterKeyFor } from '../lib/voterKey'
import type { DraftScope } from '../lib/ballotDraft'
import { rememberAnswered, rememberConfirmed, useQuestionMarks } from '../lib/questionMarks'
import { nextUnansweredKey } from '../lib/nextQuestion'
import { BallotCard } from '../components/BallotCard'
import type { BallotScore } from '../components/BallotFrame'
import { CollectOptions } from '../components/CollectOptions'
import { CreatorControls } from '../components/CreatorControls'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { NoResultsNotice, RevealNote } from '../components/PollNotices'
import { PollHeading } from '../components/PollHeading'
import { QuestionStrip } from '../components/QuestionStrip'
import { SmoothHeight } from '../components/SmoothHeight'
import { Banners } from '../components/Banners'
import { RetentionNote } from '../components/RetentionNote'
import { Ballots, preloadCards, Results, TimeBallotCard, YourBallot } from '../components/deferred'
import {
  BallotsSkeleton,
  PollPageSkeleton,
  QuestionSkeleton,
  ResultsSkeleton,
  YourBallotSkeleton,
} from '../components/Skeletons'
import { VoterNameField } from '../components/VoterNameField'
import { useVoterName } from '../lib/voterName'
import { countBadge } from '../lib/badgeColors'
import { Respondents } from '../components/Respondents'
import { readPollPage, statusFromOpenView, whenRead } from '../lib/pollPage'
import { useRemovedHere } from '../lib/removedPolls'
import { openPollViewSchema, parseAnswer, pollStatusSchema } from '../lib/rpcSchemas'
import { winnerLabel } from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import { pollIdFromParam, pollPath } from '../lib/pollId'
import { useFirstQuestionOnResults } from '../lib/resultsLanding'
import type {
  PollRead,
  AccountRead,
  BallotSheet,
  GroupQuestion,
  Invitee,
  OpenPollView,
  Poll,
  PollOption,
  PollResults,
  PollStatus,
} from '../lib/types'

/**
 * A poll read as an account: the creator's own, or one they were invited to.
 *
 * `PollPage` has already read the poll with `poll_page` and chose this page
 * because the answer was `account`; that read arrives as `initial`. This page
 * owns every read after it -- the live tick, a vote, a creator's action.
 */
export function PollDetail({
  initial,
  watch,
  reread,
  prefetched = null,
}: {
  initial: AccountRead | null
  /** Registers this page's signal handler with the route, which owns the subscription. */
  watch: (onSignal: (() => boolean | void | Promise<boolean | void>) | null) => void
  /**
   * Ask for a read through the same funnel as live signals, so a write and its
   * own broadcast echo collapse into one read. See `LiveStream.reread`.
   */
  reread: () => void
  /** This question's read, made ahead by `PollPage` while it was a neighbour. */
  prefetched?: PollRead | null
}) {
  const h24 = use24HourTime()
  const { pollId: param } = useParams<{ pollId: string }>()
  // Canonical id from here on; the URL carries the short spelling.
  const pollId = param && pollIdFromParam(param)
  const { session } = useAuth()
  const navigate = useNavigate()
  const [poll, setPoll] = useState<Poll | null>(null)
  const [options, setOptions] = useState<PollOption[]>([])
  const [status, setStatus] = useState<PollStatus | null>(null)
  // An open poll's view, held here so the heading, creator controls and panel
  // never disagree about the counts.
  const [view, setView] = useState<OpenPollView | null>(null)
  // The poll's other questions. Fixed at creation, so read with the whole page only.
  const [questions, setQuestions] = useState<GroupQuestion[]>([])
  // Card data carried by `poll_page` (null means "the card reads for itself").
  const [results, setResults] = useState<PollResults | null>(null)
  const [ballots, setBallots] = useState<BallotSheet | null>(null)
  const [invitees, setInvitees] = useState<Invitee[] | null>(null)
  const [yourScores, setYourScores] = useState<Record<string, number> | null>(null)
  // Only the whole-page read carries this, so it is kept across narrow reads.
  const removedHere = useRemovedHere(poll ? (poll.group_id ?? poll.id) : undefined)
  const { heard: heardRemoved } = removedHere
  // Question-strip marks on an open poll; see lib/questionMarks.ts.
  const {
    answered,
    confirmed,
    fromGroup: marksFromGroup,
    fromView: marksFromView,
  } = useQuestionMarks()
  // Which question the state above describes. During a crossing between
  // questions it lags the URL; the poll-level parts (heading, strip) are drawn
  // anyway and the question's half waits for this to match.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  // Held by the page so a typed name survives a crossing; see VoterNameField.
  const voterName = useVoterName(pollId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped by creator actions to remount the ballot, which rebuilds it from
  // its draft narrowed to the current options.
  const [refreshKey, setRefreshKey] = useState(0)
  // The reader's own scores while changing their vote; fetched on demand.
  const [revising, setRevising] = useState<Record<string, number> | null>(null)
  // The creator's option editor, which stands in for the ballot while open.
  const [editingOptions, setEditingOptions] = useState(false)
  // Which question has been read in full, deciding whether the next signal
  // needs the whole page or the narrow tick. A ref, so two signals arriving
  // together cannot both decide they are first.
  const readQuestion = useRef<string | null>(null)

  // The route's read, taken once.
  const handoff = useRef(initial)

  // The question on screen now. A read that lands after the reader moved on
  // (e.g. a vote's own echo, after auto-advance) is dropped rather than drawn
  // under the wrong question.
  const onScreen = useRef(pollId)
  onScreen.current = pollId

  // Fixed at creation, so carried from the first read; the open poll's tick
  // doesn't re-ask `poll_status` for it. See `statusFromOpenView`.
  const retention = useRef<PollStatus['expires_at']>(null)

  // Which group `questions` describes, and as of when. Every question's read
  // carries the whole group's marks, and a read held for a neighbour can be
  // older than one already drawn -- or than a ballot just cast here -- so the
  // newest wins rather than the last to land. See `whenRead`.
  const groupAsOf = useRef<{ group: string; at: number } | null>(null)

  const apply = useCallback(
    (page: AccountRead) => {
      setPoll(page.poll)
      setOptions(page.options)
      setStatus(page.status)
      const group = page.poll.group_id ?? page.poll.id
      const at = whenRead(page)
      const held = groupAsOf.current
      if (!held || held.group !== group || at >= held.at) {
        setQuestions(page.questions)
        groupAsOf.current = { group, at }
      }
      setResults(page.results)
      setBallots(page.ballots)
      setInvitees(page.invitees)
      setYourScores(page.your_scores)
      heardRemoved(page.removed)
      retention.current = page.status.expires_at

      // An open poll read by its creator. Group marks first, then this
      // question's view, which is newer.
      if (page.view) {
        setView(page.view)
        marksFromGroup(page.questions)
        marksFromView(page.poll.id, page.view)
      }

      readQuestion.current = page.poll.id
      setLoadedFor(page.poll.id)
      setLoading(false)
    },
    [marksFromGroup, marksFromView, heardRemoved],
  )

  // Draw the route's read before first paint, rather than waiting for the
  // socket; the subscription's first signal then takes the narrow path.
  useLayoutEffect(() => {
    const given = handoff.current
    if (!given) return
    handoff.current = null
    apply(given)
  }, [apply])

  // Draw a read-ahead before paint, so stepping to a neighbour shows no
  // skeleton. Once per visit; a read of the wrong kind means the poll changed,
  // so re-read. The opening read counts as already adopted.
  const adopted = useRef<{ pollId: string; read: PollRead } | null>(
    initial && pollId ? { pollId, read: initial } : null,
  )
  useLayoutEffect(() => {
    if (adopted.current && adopted.current.pollId !== pollId) adopted.current = null
    if (!prefetched || !pollId || adopted.current?.read === prefetched) return
    adopted.current = { pollId, read: prefetched }
    if (prefetched.kind === 'account') apply(prefetched)
    else reread()
  }, [prefetched, pollId, apply, reread])

  const load = useCallback(async () => {
    if (!pollId) return true
    setError(null)
    // See `refresh` for why these are dropped.
    setResults(null)
    setBallots(null)
    setYourScores(null)

    const { page, error: readError } = await readPollPage(pollId)
    if (page) await preloadCards(page)
    if (onScreen.current !== pollId) return true

    // Deleted or uninvited while open. No falling back to the public reading:
    // the route already decided, so the poll changed underneath us.
    if (readError || !page || page.kind !== 'account') {
      setError(readError ?? 'Poll not found.')
      setLoading(false)
      return false
    }

    apply(page)
    return true
  }, [pollId, apply])

  // Whether the tick re-reads an invite poll's options: while nobody has
  // voted, suggestions and corrections can land from elsewhere. (Open polls'
  // options come with the view; corrections after votes force a whole-page read.)
  const optionsMayMove = poll?.mode === 'invite' && status?.voted_count === 0

  // Whether the opening read carried a roster; `poll_invitees` raises rather
  // than answering empty, so only ask where there is one.
  const hasRoster = invitees !== null

  /** The live tick: counts, stage, and (where they can move) options and roster. */
  const refresh = useCallback(async () => {
    if (!pollId) return true
    // Dropped because this read doesn't carry them, and a reopen/close in
    // between would otherwise hand a card a stale tally. The roster is kept,
    // or the card would blink on every vote.
    setResults(null)
    setBallots(null)
    setYourScores(null)

    const openId = poll?.mode === 'open' ? poll.id : null
    const [statusRes, viewRes, optionsRes, inviteesRes] = await Promise.all([
      // An open poll's view already contains everything `poll_status` would.
      openId ? null : supabase.rpc('poll_status', { p_poll_id: pollId }).single(),
      openId
        ? supabase.rpc('open_poll_view', { p_poll_id: openId, p_voter_key: voterKeyFor(openId) })
        : null,
      optionsMayMove
        ? supabase.from('candidates').select('*').eq('poll_id', pollId).order('sort_order')
        : null,
      hasRoster ? supabase.rpc('poll_invitees', { p_poll_id: pollId }) : null,
    ])
    if (onScreen.current !== pollId) return true

    // A failed or malformed tick changes nothing on screen; the next one retries.
    const view =
      viewRes && !viewRes.error && viewRes.data
        ? parseAnswer(openPollViewSchema, 'open_poll_view', viewRes.data).value
        : null
    if (view && openId) {
      setView(view)
      marksFromView(openId, view)
    }

    const status = statusRes
      ? statusRes.error
        ? null
        : parseAnswer(pollStatusSchema, 'poll_status', statusRes.data).value
      : view && statusFromOpenView(view, retention.current)
    if (status) setStatus(status)

    if (optionsRes && !optionsRes.error && optionsRes.data)
      setOptions(optionsRes.data as PollOption[])
    if (inviteesRes && !inviteesRes.error && inviteesRes.data)
      setInvitees(inviteesRes.data as Invitee[])

    // Only the status decides whether this read counts; options and roster
    // may lag a tick.
    return !!status
  }, [pollId, poll?.mode, poll?.id, optionsMayMove, hasRoster, marksFromView])

  // Set when the next read must be the whole page: after a creator action
  // (the tick doesn't re-read the poll row or group), and after an invite
  // ballot or confirmation (the strip's marks come from `poll_group`).
  const wholePage = useRef(false)

  // The one read handler, for signals and the page's own writes alike. A
  // crossing to another question shows up as `readQuestion` not matching.
  // The creator of a collecting poll of several questions reads the whole
  // page on every tick: *Open poll* is gated on every question's option count,
  // which only `poll_group` carries, and a suggestion to any question can
  // change it.
  const groupMayMove =
    !!poll?.group_id && !!status?.soliciting && poll.created_by === session?.user.id

  const onRead = useCallback(async () => {
    if (wholePage.current || groupMayMove || readQuestion.current !== pollId) {
      wholePage.current = false
      return load()
    }
    return refresh()
  }, [pollId, load, refresh, groupMayMove])

  // A crossing remounts nothing, so drop a half-changed ballot from the last question.
  useEffect(() => {
    setRevising(null)
  }, [pollId])

  // Kept registered even once settled: the creator can still reopen the poll.
  useEffect(() => {
    watch(onRead)
    return () => watch(null)
  }, [watch, onRead])

  const reloadPage = useCallback(() => {
    wholePage.current = true
    reread()
  }, [reread])

  // Close, reopen and option corrections also remount the open-poll panel's
  // half-filled ballot; a vote doesn't need to.
  const reloadAll = useCallback(() => {
    setRefreshKey((k) => k + 1)
    wholePage.current = true
    reread()
  }, [reread])

  // Whether the creator may correct the options now (same terms as the
  // database). Above the early returns so the effect can close the editor if
  // the poll closes underneath it.
  const editable =
    !!poll &&
    !!status &&
    poll.created_by === session?.user.id &&
    !status.soliciting &&
    !status.is_closed

  useEffect(() => {
    if (!editable) setEditingOptions(false)
  }, [editable])

  const hasVoted = status?.voted === true
  useEffect(() => {
    if (!hasVoted) setRevising(null)
  }, [hasVoted])

  useFirstQuestionOnResults(pollId, poll?.group_id, status?.results_available, questions)

  if (loading) return <PollPageSkeleton />

  if (error || !poll || !status) {
    return (
      <Text role="alert" c="red" ta="center">
        {error ?? 'Poll not found.'}
      </Text>
    )
  }

  const isCreator = poll.created_by === session?.user.id
  const isOpen = poll.mode === 'open'
  // False only mid-crossing between questions; gates the question's half.
  const showing = loadedFor === pollId
  // Not a sibling question: a different poll, so a full skeleton rather than
  // this poll's heading.
  if (!showing && !questions.some((question) => question.id === pollId)) {
    return <PollPageSkeleton />
  }
  // "Done" means confirmed while collecting and voted afterwards. Invite polls
  // ask the server; open polls ask this browser.
  const done = status.soliciting
    ? { browser: confirmed, server: (question: GroupQuestion) => question.confirmed === true }
    : { browser: answered, server: (question: GroupQuestion) => question.voted }
  // Once closed, the strip marks nothing (no ballot can still be cast). The
  // same fact decides whether the strip sits inside a card or above the block.
  const finished = status.is_closed || status.results_available
  const marking = !finished
  const strip = questions.map((question) => ({
    key: question.id,
    position: question.question_position,
    title: question.question_title,
    answered: marking
      ? isOpen
        ? done.browser.has(question.id)
        : done.server(question)
      : undefined,
  }))
  // Built once and passed to every branch, so no branch can draw a different list.
  const questionStrip = (
    <QuestionStrip questions={strip} current={pollId ?? poll.id} hrefFor={(id) => pollPath(id)} />
  )
  // What the crossing skeleton needs to know to match the question being
  // opened. `tallied` is borrowed from the question being left -- a guess,
  // but questions of one poll nearly always end alike. See QuestionSkeleton.
  const asksName = isOpen && poll.show_voters && marking
  const answeredHere = done.browser.has(pollId ?? poll.id)
  const tallied = status.results_available
  const opening = questions.find((question) => question.id === pollId)

  // A first ballot carries the reader on to the next question they owe. See
  // lib/nextQuestion.ts.
  const onwards = nextUnansweredKey(strip, poll.id)
  const advance = onwards
    ? () => {
        // Nothing re-reads the question being left, so record its mark here:
        // in this browser on an open poll, and in the group on an invite poll,
        // where the next question's held read predates this ballot.
        if (isOpen) (status.soliciting ? rememberConfirmed : rememberAnswered)(poll.id)
        else {
          const mark = status.soliciting ? { confirmed: true } : { voted: true }
          setQuestions((held) =>
            held.map((question) => (question.id === poll.id ? { ...question, ...mark } : question)),
          )
          groupAsOf.current = { group: poll.group_id ?? poll.id, at: performance.now() }
        }
        navigate(pollPath(onwards))
      }
    : undefined
  const optionList = isOpen ? (view?.options ?? []) : options
  // Confirming is for invitees of a collecting invite poll.
  const confirmation =
    !isOpen && status.soliciting && status.invited
      ? {
          confirmed: status.confirmed,
          opensWhenEveryoneHas:
            status.invited_count > 0 && status.confirmed_count < status.invited_count,
        }
      : undefined

  return (
    <Stack maw={720} mx="auto" gap="md">
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
          confirmedCount: status.confirmed_count,
          optionCount: optionList.length,
          // A poll of one question has an empty group.
          questionCount: questions.length || 1,
        }}
        state={{
          soliciting: status.soliciting,
          resultsAvailable: status.results_available,
          closed: status.is_closed,
          // `undefined` = not settled; null = no winner.
          winner: status.winner_settled ? winnerLabel(status.winner_name, h24) : undefined,
          inGroup: !!poll.group_id,
        }}
      />

      {/* The question's half: the only part that waits on a crossing. */}
      <SmoothHeight>
        {showing ? (
          <>
            {editingOptions && editable ? (
              <CollectOptions
                source={{ kind: 'creator', pollId: poll.id }}
                options={optionList}
                schedule={poll.kind === 'time' ? poll.schedule : null}
                isCreator
                questionStrip={questionStrip}
                done={{
                  note:
                    status.voted_count > 0
                      ? 'Votes have already been cast. The results will say the options were edited after voting started.'
                      : 'Nobody has voted yet, so options can still be updated.',
                  onDone: () => setEditingOptions(false),
                }}
                onChanged={reloadAll}
              />
            ) : /* The creator votes in their own open poll through the same
                 anon RPCs as everyone else. */
            isOpen ? (
              view && (
                <OpenPollPanel
                  key={refreshKey}
                  pollId={poll.id}
                  view={view}
                  results={results}
                  ballots={ballots}
                  isCreator={isCreator}
                  voterName={voterName}
                  removed={removedHere.removed}
                  onRestored={removedHere.onRestored}
                  onChanged={reread}
                  onFirstVote={advance}
                  onFirstConfirm={advance}
                  questionStrip={questionStrip}
                />
              )
            ) : status.soliciting ? (
              <>
                <CollectOptions
                  source={{ kind: 'poll', pollId: poll.id }}
                  options={options}
                  schedule={poll.kind === 'time' ? poll.schedule : null}
                  isCreator={isCreator}
                  questionStrip={questionStrip}
                  confirm={confirmation}
                  onChanged={reloadAll}
                  onConfirmed={advance}
                />
                {confirmation?.confirmed && (
                  <Banners
                    pollId={poll.id}
                    removed={removedHere.removed}
                    onRestored={removedHere.onRestored}
                  />
                )}
              </>
            ) : status.results_available ? (
              /* No card to hold the strip here, so it sits above the tally in
                 a stack of its own: what follows it is what slides on a
                 crossing. */
              <Stack gap="md">
                {questionStrip}
                <Suspense fallback={<ResultsSkeleton options={optionList.length || undefined} />}>
                  <Results
                    source={{ kind: 'poll', pollId: poll.id }}
                    meeting={
                      poll.kind === 'time' && poll.schedule
                        ? { title: poll.title, schedule: poll.schedule }
                        : null
                    }
                    initial={results}
                  />
                </Suspense>
              </Stack>
            ) : status.is_closed ? (
              <Stack gap="md">
                {questionStrip}
                <NoResultsNotice inGroup={!!poll.group_id} />
              </Stack>
            ) : status.voted ? (
              /* Voted and results still sealed: the window a vote can change in. */
              revising ? (
                <VoteForm
                  poll={poll}
                  options={options}
                  initial={revising}
                  onVoted={() => {
                    setRevising(null)
                    reloadPage()
                  }}
                  onCancel={() => setRevising(null)}
                  questionStrip={questionStrip}
                />
              ) : (
                <Waiting
                  status={status}
                  pollId={poll.id}
                  removed={removedHere.removed}
                  onRestored={removedHere.onRestored}
                  onRevise={setRevising}
                  questionStrip={questionStrip}
                />
              )
            ) : (
              <VoteForm
                key={refreshKey}
                poll={poll}
                options={options}
                onVoted={advance ?? reloadPage}
                questionStrip={questionStrip}
              />
            )}
          </>
        ) : (
          // The strip and name box are real, not shapes: they belong to the poll.
          <QuestionSkeleton
            finished={finished}
            tallied={tallied}
            collecting={status.soliciting}
            rows={opening?.option_count}
            nameField={
              asksName ? <VoterNameField name={voterName} disabled={answeredHere} /> : undefined
            }
            strip={questionStrip}
          />
        )}
      </SmoothHeight>

      {/* Nothing below is drawn mid-crossing: it would be pushed down when the
          question's half lands. The roster is present exactly when `poll_page`
          carried one (the creator, or a poll that shows respondents). */}
      {showing && !isOpen && invitees && (
        <Stack gap={2}>
          <Title order={2} size="h4">
            Voters
          </Title>
          <Respondents
            pollId={poll.id}
            isCreator={isCreator}
            status={status}
            invitees={invitees}
            onChange={reloadAll}
          />
        </Stack>
      )}

      {/* Invite polls only; OpenPollPanel already draws an open poll's ballots. */}
      {showing && !isOpen && status.results_available && poll.show_ballots && (
        <Suspense
          fallback={
            <BallotsSkeleton
              rows={status.voted_count || undefined}
              schedule={poll.kind === 'time' ? poll.schedule : null}
            />
          }
        >
          <Ballots
            source={{ kind: 'poll', pollId: poll.id }}
            title={poll.title}
            question={poll.question_title}
            initial={ballots}
            schedule={poll.kind === 'time' ? poll.schedule : null}
          />
        </Suspense>
      )}

      {/* Where ballots are private, the reader's own instead. */}
      {showing && !isOpen && status.results_available && !poll.show_ballots && status.voted && (
        <Suspense
          fallback={
            <YourBallotSkeleton
              rows={optionList.length || undefined}
              schedule={poll.kind === 'time' ? poll.schedule : null}
            />
          }
        >
          <YourBallot
            pollId={poll.id}
            options={optionList}
            initial={yourScores}
            schedule={poll.kind === 'time' ? poll.schedule : null}
          />
        </Suspense>
      )}

      {showing && isCreator && (
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

      {showing && isCreator && <RetentionNote expiresAt={status.expires_at} />}
    </Stack>
  )
}

/**
 * Voted, results still sealed: the window in which the vote can change. On an
 * invite poll that window ends the moment the last invitee votes. The invite
 * side's twin of `Voted` in OpenPollPanel.
 */
function Waiting({
  status,
  pollId,
  removed,
  onRestored,
  onRevise,
  questionStrip,
}: {
  status: PollStatus
  pollId: string
  removed?: boolean
  onRestored?: () => void
  /** The ballot came back: hand it to the page, which puts the form up. */
  onRevise: (scores: Record<string, number>) => void
  questionStrip?: ReactNode
}) {
  const [loading, setLoading] = useState(false)
  const pct = status.invited_count === 0 ? 0 : (status.voted_count / status.invited_count) * 100

  async function handleRevise() {
    setLoading(true)
    const { data, error } = await supabase.rpc('poll_ballot_scores', { p_poll_id: pollId })
    setLoading(false)

    // Most likely the last invitee just voted and the results are out; the
    // next tick replaces this card anyway.
    if (error) {
      notifications.show({ message: error.message, color: 'red' })
      return
    }
    onRevise((data as Record<string, number>) ?? {})
  }

  return (
    <Stack gap="md">
      <Card withBorder>
        <Stack gap="sm">
          {questionStrip}
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text fw={500}>Your vote is in.</Text>
            <Badge {...countBadge}>
              {status.voted_count}/{status.invited_count} voted
            </Badge>
          </Group>
          <Progress value={pct} />
          <Group justify="space-between" wrap="wrap" gap="sm">
            <RevealNote reveal={{ kind: 'invite' }} canRevise grow />
            <Button
              variant="light"
              onClick={handleRevise}
              leftSection={<PencilSimpleIcon size={16} aria-hidden />}
              loading={loading}
              style={{ marginLeft: 'auto' }}
            >
              Edit vote
            </Button>
          </Group>
        </Stack>
      </Card>
      <Banners pollId={pollId} removed={removed} onRestored={onRestored} />
    </Stack>
  )
}

/**
 * An invite poll's ballot, new or being changed (`initial`). `BallotCard` or
 * `TimeBallotCard` draws it; this decides where the scores go.
 */
function VoteForm({
  poll,
  options,
  initial,
  onVoted,
  onCancel,
  questionStrip,
}: {
  poll: Pick<Poll, 'id' | 'kind' | 'schedule' | 'group_id'>
  options: PollOption[]
  /** The scores already on this voter's ballot; absent when casting a new one. */
  initial?: Record<string, number>
  onVoted: () => void
  /** Offered only when changing a vote. */
  onCancel?: () => void
  questionStrip?: ReactNode
}) {
  const revising = initial !== undefined
  const { session } = useAuth()
  // A new ballot is drafted in this browser until it goes in; a revision isn't.
  const draft: DraftScope | undefined = revising
    ? undefined
    : { pollId: poll.id, groupId: poll.group_id, owner: session?.user.id ?? null }

  async function send(scores: BallotScore[]) {
    const { error } = await supabase.rpc(revising ? 'revise_ballot' : 'submit_ballot', {
      p_poll_id: poll.id,
      p_scores: scores,
    })
    if (error) throw new Error(error.message)
  }

  if (poll.kind === 'time' && poll.schedule) {
    return (
      <Suspense fallback={<QuestionSkeleton schedule={poll.schedule} strip={questionStrip} />}>
        <TimeBallotCard
          options={options}
          schedule={poll.schedule}
          initial={initial}
          draft={draft}
          questionStrip={questionStrip}
          note={<RevealNote reveal={{ kind: 'invite' }} canRevise />}
          onSubmit={send}
          onVoted={onVoted}
          onCancel={onCancel}
        />
      </Suspense>
    )
  }

  return (
    <BallotCard
      options={options}
      initial={initial}
      draft={draft}
      questionStrip={questionStrip}
      note={<RevealNote reveal={{ kind: 'invite' }} canRevise />}
      onSubmit={send}
      onVoted={onVoted}
      onCancel={onCancel}
    />
  )
}
