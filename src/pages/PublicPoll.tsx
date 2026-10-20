import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Stack, Text, Title } from '@mantine/core'
import { isSampleId, openPollRpc, SAMPLE_RESULT_ID } from '../lib/samplePoll'
import { readPollPage } from '../lib/pollPage'
import { useRemovedHere } from '../lib/removedPolls'
import { openPollViewSchema, parseAnswer } from '../lib/rpcSchemas'
import { voterKeyFor } from '../lib/voterKey'
import { rememberAnswered, rememberConfirmed, useQuestionMarks } from '../lib/questionMarks'
import { nextUnansweredKey } from '../lib/nextQuestion'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { preloadCards } from '../components/deferred'
import { PollHeading } from '../components/PollHeading'
import { QuestionStrip } from '../components/QuestionStrip'
import { SmoothHeight } from '../components/SmoothHeight'
import { useResultsLanding } from '../lib/resultsLanding'
import { PollPageSkeleton, QuestionSkeleton } from '../components/Skeletons'
import { VoterNameField } from '../components/VoterNameField'
import { useVoterName } from '../lib/voterName'
import { winnerLabel } from '../lib/schedule'
import { use24HourTime } from '../lib/clock'
import { pollIdFromParam, pollPath } from '../lib/pollId'
import type {
  BallotSheet,
  OpenGroupQuestion,
  OpenPollView,
  OpenRead,
  PollRead,
  PollResults,
  UnreadableRead,
} from '../lib/types'
import { usePageTitle } from '../lib/pageTitle'

/**
 * An open poll as anyone holding the link sees it, through the anon RPCs
 * only -- which is also what a signed-in stranger sees. `PollPage` usually
 * hands over its read as `initial`; the sample reads for itself. A read
 * tagged `unreadable` draws "Poll not found".
 */
export function PublicPoll({
  initial,
  watch,
  reread,
  prefetched = null,
}: {
  /** `PollPage`'s read, or null (the sample, or a crossing). Used once. */
  initial: OpenRead | UnreadableRead | null
  /** Registers this page's signal handler with the route. */
  watch: (onSignal: (() => boolean | void | Promise<boolean | void>) | null) => void
  /** A read through the live funnel; see `LiveStream.reread`. */
  reread: () => void
  /** This question's read, made ahead by `PollPage`. */
  prefetched?: PollRead | null
}) {
  const h24 = use24HourTime()
  const { pollId: param } = useParams<{ pollId: string }>()
  const pollId = param && pollIdFromParam(param)
  const navigate = useNavigate()
  // The latest read and which question it was of, as one value so they can't
  // drift during a crossing.
  const [read, setRead] = useState<{
    pollId: string
    view: OpenPollView
    results: PollResults | null
    ballots: BallotSheet | null
  } | null>(null)
  const [questions, setQuestions] = useState<OpenGroupQuestion[]>([])
  // Only `poll_page` carries this, so it is kept across narrow reads.
  const removedHere = useRemovedHere(read ? (read.view.poll.group_id ?? read.pollId) : undefined)
  const { heard: heardRemoved } = removedHere
  // Strip marks; see lib/questionMarks.ts.
  const {
    answered,
    confirmed,
    fromGroup: marksFromGroup,
    fromView: marksFromView,
  } = useQuestionMarks()
  const [failed, setFailed] = useState<{ pollId: string; message: string } | null>(null)
  // Which question has been read, so a failed refresh isn't mistaken for a
  // failed first read. A ref, to keep `load` stable (rebuilding it resubscribes).
  const loadedFor = useRef<string | null>(null)
  // Questions the strip in hand covers (including this one), for the same reason.
  const covered = useRef<string[]>([])
  // Held by the page so a typed name survives a crossing; see VoterNameField.
  const voterName = useVoterName(pollId)
  const handoff = useRef(initial)

  // Drop a read that lands after the reader moved on; see PollDetail.
  const onScreen = useRef(pollId)
  onScreen.current = pollId

  /** What every read does with its view. Omitting `tally`/`sheet` drops them (cards read for themselves). */
  const finish = useCallback(
    (
      of: string,
      openView: OpenPollView,
      strip?: OpenGroupQuestion[],
      tally?: PollResults | null,
      sheet?: BallotSheet | null,
    ) => {
      if (strip) {
        // Include the question itself: a single-question poll's group is empty.
        covered.current = [of, ...strip.map((question) => question.id)]
        setQuestions(strip)
        marksFromGroup(strip)
      }
      loadedFor.current = of
      setRead({ pollId: of, view: openView, results: tally ?? null, ballots: sheet ?? null })
      // After the group: this question's view is newer.
      marksFromView(of, openView)
    },
    [marksFromGroup, marksFromView],
  )

  const finishPage = useCallback(
    (of: string, page: OpenRead) => {
      finish(of, page.view, page.questions, page.results, page.ballots)
      heardRemoved(page.removed)
    },
    [finish, heardRemoved],
  )

  // Draw the route's read before first paint; see PollDetail.
  useLayoutEffect(() => {
    const given = handoff.current
    if (!given || !pollId) return
    handoff.current = null
    if (given.kind === 'open') finishPage(pollId, given)
    else setFailed({ pollId, message: 'Poll not found.' })
  }, [pollId, finishPage])

  // Draw a read-ahead before paint; see PollDetail.
  const adopted = useRef<{ pollId: string; read: PollRead } | null>(
    initial && pollId ? { pollId, read: initial } : null,
  )
  useLayoutEffect(() => {
    if (adopted.current && adopted.current.pollId !== pollId) adopted.current = null
    if (!prefetched || !pollId || adopted.current?.read === prefetched) return
    adopted.current = { pollId, read: prefetched }
    if (prefetched.kind === 'open') finishPage(pollId, prefetched)
    else reread()
  }, [prefetched, pollId, finishPage, reread])

  /**
   * The first read of a question (arrival or crossing) is `poll_page`, which
   * brings the strip and, on a finished question, the tally. Later reads of
   * the same question are `open_poll_view` alone.
   */
  const load = useCallback(async () => {
    if (!pollId) return true

    if (!covered.current.includes(pollId) || loadedFor.current !== pollId) {
      const { page, error: readError } = await readPollPage(pollId)
      if (page) await preloadCards(page)
      if (onScreen.current !== pollId) return true

      if (readError || !page || page.kind === 'unreadable') {
        // Only a failed first read means the link is bad.
        if (loadedFor.current !== pollId) {
          setFailed({ pollId, message: readError ?? 'Poll not found.' })
        }
        return false
      }
      if (page.kind === 'open') {
        finishPage(pollId, page)
        return true
      }
    }

    const { data, error: rpcError } = await openPollRpc('open_poll_view', {
      p_poll_id: pollId,
      p_voter_key: voterKeyFor(pollId),
    })
    if (onScreen.current !== pollId) return true
    // A failed or malformed refresh keeps what is on screen.
    const { value, error: shape } = rpcError
      ? { value: null, error: rpcError.message }
      : parseAnswer(openPollViewSchema, 'open_poll_view', data)

    if (!value) {
      if (loadedFor.current !== pollId) {
        setFailed({ pollId, message: shape ?? 'Poll not found.' })
      }
      return false
    }
    finish(pollId, value)
    return true
  }, [pollId, finish, finishPage])

  // This question's own read; null mid-crossing.
  const view = read && read.pollId === pollId ? read.view : null
  const results = read && read.pollId === pollId ? read.results : null
  const ballots = read && read.pollId === pollId ? read.ballots : null
  // A sibling question's read, which still describes the poll (title, terms,
  // strip), so the heading stays put during a crossing.
  const sibling =
    read &&
    questions.some((question) => question.id === read.pollId) &&
    questions.some((question) => question.id === pollId)
      ? read.view
      : null
  const shell = view ?? sibling
  const error = failed && failed.pollId === pollId ? failed.message : null

  const known = questions.some((question) => question.id === pollId)

  const sample = !!pollId && isSampleId(pollId)
  const resultsLive = useResultsLanding(read?.pollId, !!read?.view.results_available)

  // Kept registered even once settled: the creator can reopen.
  useEffect(() => {
    watch(load)
    return () => watch(null)
  }, [watch, load])

  // The sample has no topic, so it reads for itself.
  useEffect(() => {
    if (sample) void load()
  }, [sample, load])

  usePageTitle(!pollId || error ? 'Poll not found' : null)

  if (!pollId || error) {
    return (
      <Stack maw={720} mx="auto" gap="md" align="center">
        <Title order={1} size="h3">
          Poll not found
        </Title>
        <Text c="dimmed" ta="center">
          This link may be mistyped, or the poll may have been deleted.
        </Text>
      </Stack>
    )
  }

  if (!shell) return <PollPageSkeleton />

  // "Done" is the confirmation while collecting, the ballot after. Once
  // finished the strip marks nothing, and sits above the block, not in a card.
  const collecting = shell.soliciting
  const done = collecting ? confirmed : answered
  const finished = shell.is_closed || shell.results_available
  const marking = !finished
  const strip = questions.map((question) => ({
    key: question.id,
    position: question.question_position,
    title: question.question_title,
    answered: marking ? done.has(question.id) : undefined,
  }))
  const questionCount = !shell.poll.group_id ? 1 : known ? questions.length : 1
  const onwards = nextUnansweredKey(strip, pollId)
  // The sample's last ballot leads to its finished copy, which is the point
  // of offering the two side by side.
  const leaving = sample && !onwards && !collecting && !finished ? pollPath(SAMPLE_RESULT_ID) : null
  const onward = onwards ? pollPath(onwards) : leaving
  // Advancing doesn't re-read the question left, so record its mark here.
  const advance = onward
    ? () => {
        ;(collecting ? rememberConfirmed : rememberAnswered)(pollId)
        navigate(onward)
      }
    : undefined
  // Built once: the panel and the crossing skeleton draw the same strip.
  const questionStrip = (
    <QuestionStrip questions={strip} current={pollId} hrefFor={(next) => pollPath(next)} />
  )
  const asksName = shell.poll.show_voters && marking && !done.has(pollId)

  return (
    <Stack maw={720} mx="auto" gap="md">
      {/* No creator: a share link goes beyond the poll's own people, so no
          email address is shown here. */}
      <PollHeading
        title={shell.poll.title}
        description={shell.poll.description}
        createdBy={null}
        mode={shell.poll.mode}
        showVoters={shell.poll.show_voters}
        showBallots={shell.poll.show_ballots}
        turnout={{
          soliciting: shell.soliciting,
          mode: shell.poll.mode,
          votedCount: shell.voted_count,
          invitedCount: 0,
          confirmedCount: shell.confirmed_count,
          optionCount: shell.options.length,
          questionCount,
        }}
        state={{
          soliciting: shell.soliciting,
          resultsAvailable: shell.results_available,
          closed: shell.is_closed,
          winner: shell.winner_settled ? winnerLabel(shell.winner_name ?? null, h24) : undefined,
          inGroup: !!shell.poll.group_id,
        }}
      />

      {/* The question's half: the only part that waits on a crossing. */}
      <SmoothHeight>
        {view ? (
          <OpenPollPanel
            pollId={pollId}
            resultsLive={resultsLive}
            view={view}
            results={results}
            ballots={ballots}
            removed={removedHere.removed}
            onRestored={removedHere.onRestored}
            onChanged={reread}
            onFirstVote={advance}
            onFirstConfirm={advance}
            voterName={voterName}
            questionStrip={questionStrip}
          />
        ) : (
          // `tallied` and the row count are guesses from the question being
          // left; open polls carry no per-question option counts.
          <QuestionSkeleton
            finished={finished}
            tallied={shell.results_available}
            rows={shell.options.length}
            collecting={shell.soliciting}
            nameField={asksName ? <VoterNameField name={voterName} /> : undefined}
            strip={questionStrip}
          />
        )}
      </SmoothHeight>
    </Stack>
  )
}
