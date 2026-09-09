import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Divider, Stack, Text, Title } from '@mantine/core'
import { isSampleId, openPollRpc } from '../lib/samplePoll'
import { readPollPage } from '../lib/pollPage'
import { openPollViewSchema, parseAnswer } from '../lib/rpcSchemas'
import { voterKeyFor } from '../lib/voterKey'
import {
  answeredQuestions,
  confirmedQuestions,
  forgetAnswered,
  forgetConfirmed,
  rememberAnswered,
  rememberConfirmed,
} from '../lib/questionMarks'
import { nextUnansweredKey } from '../lib/nextQuestion'
import type { LiveStatus } from '../lib/useLiveStream'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { PollHeading } from '../components/PollHeading'
import { QuestionStrip } from '../components/QuestionStrip'
import { PollPageSkeleton, QuestionSkeleton } from '../components/Skeletons'
import { VoterNameField } from '../components/VoterNameField'
import { useVoterName } from '../lib/voterName'
import type {
  BallotSheet,
  OpenGroupQuestion,
  OpenPollView,
  OpenRead,
  PollResults,
  UnreadableRead,
} from '../lib/types'

/**
 * An open poll as somebody outside it sees it: not signed in, and possibly
 * never going to be. It renders inside the ordinary app shell, because
 * landing here is how plenty of people first meet the site and the header is
 * what tells them there is one, with the way to sign in on it.
 *
 * It reads the poll through the anon RPCs and nothing else, so this is also
 * exactly what a signed-in stranger holding the link can see; `PollPage`
 * sends them here when the poll is not theirs to read as an account. The
 * address is the same either way, since a poll's id is its link.
 *
 * `PollPage` has usually read the poll already by the time this mounts and
 * hands the result over as `initial` — including the tag that says the link
 * is not a link at all, which is what the card at the bottom of this file
 * draws. The sample is the exception: it is answered out of a file and routed
 * here without anybody asking the database anything, so it reads for itself,
 * and a mistyped sample link fails that read and draws the same card.
 */
export function PublicPoll({
  initial,
  live,
  watch,
}: {
  /**
   * The read `PollPage` made on this question's behalf, or null when it had
   * none to give: the sample, or a crossing to another question of the same
   * poll. Used once and then dropped — see `handoff` below.
   */
  initial: OpenRead | UnreadableRead | null
  /** Whether the route's subscription is carrying, for the notice below. */
  live: LiveStatus
  /**
   * Registers what this page does with a signal. The route holds the
   * subscription — see `PollPage` — and calls this back in place of its own
   * read once there is a page to ask.
   */
  watch: (onSignal: (() => boolean | void | Promise<boolean | void>) | null) => void
}) {
  const { pollId } = useParams<{ pollId: string }>()
  const navigate = useNavigate()
  // The most recent read, and which question it was of, held as one value so
  // the two cannot drift. A poll of several questions is served by one page
  // whose parameter changes, so "the view" and "the view of what is on screen"
  // are different things for as long as a read is in flight.
  // The tally travels in here too, rather than beside it: it is the same
  // question's, from the same read, and holding it separately would let the
  // two describe different questions for as long as a read is in flight.
  const [read, setRead] = useState<{
    pollId: string
    view: OpenPollView
    results: PollResults | null
    ballots: BallotSheet | null
  } | null>(null)
  const [questions, setQuestions] = useState<OpenGroupQuestion[]>([])
  // Which questions of this poll this browser has answered, and which it has
  // finished adding options to, for the strip's marks. They have to be read
  // into state rather than off storage at render time because storage is what
  // changes when a ballot or a confirmation goes in and React is not watching
  // it; `load` below refreshes both on the same read that learns it landed.
  // See lib/questionMarks.ts for why the browser is the only party that can
  // answer either on an open poll.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(answeredQuestions)
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(confirmedQuestions)
  const [failed, setFailed] = useState<{ pollId: string; message: string } | null>(null)
  // Which question a read has come back for, so a refresh that fails can be
  // told apart from a first read that did — and told apart per question, since
  // one page serves every question of a poll and a question nobody has read
  // yet is a first read whatever came before it. A ref rather than `read`
  // itself, which would put the poll in load()'s dependencies.
  const loadedFor = useRef<string | null>(null)
  // Which questions the strip in hand covers, which is what decides whether
  // opening one needs the whole page or only its ballot. The same list as
  // `questions`, kept as a ref beside it because `load` has to ask during a
  // read rather than at the next render — and because a poll in load()'s
  // dependencies would rebuild it whenever the group arrived, and rebuilding
  // `load` resubscribes.
  const covered = useRef<string[]>([])
  // The name this browser is answering under, held here rather than inside
  // the card that asks for it. A name belongs to the person rather than to
  // the question — it is the same on question 5 as on question 1 — and a
  // crossing between two questions replaces that card, so a name held in
  // there was thrown away by the crossing and the box itself blinked out with
  // it. Here it outlives the crossing, and the stand-in below draws the very
  // same field. See VoterNameField.
  const voterName = useVoterName(pollId)
  // The read `PollPage` already made for this question, waiting to be drawn
  // rather than made again. A ref rather than state because it is not
  // something this page renders from — it is one read's worth of work already
  // done, taken once and then gone. A poll re-read after a vote must never
  // come back with the answer from before it.
  const handoff = useRef(initial)

  // What every read below does with the view it came back with, wherever it
  // came from. One copy, because a page that recorded the ballot on one path
  // and not on another would leave the strip's marks depending on which read
  // happened to be first.
  const finish = useCallback(
    (
      of: string,
      openView: OpenPollView,
      strip?: OpenGroupQuestion[],
      // The tally and the published sheet, when the read that came back
      // carried them. `poll_page` does on a poll whose results are out;
      // `open_poll_view` never does, and passing nothing is what drops the
      // last one — the cards below then read for themselves, which is the
      // honest answer for a read that did not bring an answer.
      tally?: PollResults | null,
      sheet?: BallotSheet | null,
    ) => {
      if (strip) {
        // The question just read as well as its siblings. A poll that asks one
        // question has an empty group, and without the question itself here
        // every later read of that poll would call itself an arrival and fetch
        // the strip it already knows it does not have.
        covered.current = [of, ...strip.map((question) => question.id)]
        setQuestions(strip)
      }
      loadedFor.current = of
      setRead({ pollId: of, view: openView, results: tally ?? null, ballots: sheet ?? null })
      // Erased rather than only written: a creator who clears the poll's votes
      // leaves this browser holding a record of a ballot that no longer exists,
      // a confirmation can be taken back on the card that gave it, and a read
      // that comes back "no" is what says so.
      if (openView.voted) rememberAnswered(of)
      else forgetAnswered(of)
      if (openView.confirmed) rememberConfirmed(of)
      else forgetConfirmed(of)
      setAnswered(answeredQuestions())
      setConfirmed(confirmedQuestions())
    },
    [],
  )

  // The route's read, drawn at once rather than waiting to be asked for. See
  // the same effect in PollDetail for why this one does not wait to be
  // invited the way every other read on this page does.
  useEffect(() => {
    const given = handoff.current
    if (!given || !pollId) return
    handoff.current = null
    if (given.kind === 'open')
      finish(pollId, given.view, given.questions, given.results, given.ballots)
    // The link is not a link, which `PollPage` established rather than this
    // page having to be refused twice to find out. Same card either way.
    else setFailed({ pollId, message: 'Poll not found.' })
  }, [pollId, finish])

  // The whole poll, read once here and handed to the panel below: this page
  // needs the title and the tags, the panel needs everything else, and one
  // copy, re-read on one signal, is what keeps them agreeing.
  //
  // The first read of a question is `poll_page`, which brings the strip with
  // it; every read after that is `open_poll_view` alone. Which questions a
  // poll asks is frozen at creation, so re-reading the strip on every signal
  // would be asking for something that cannot have changed — and this page
  // re-reads on every vote anybody casts.
  const load = useCallback(async () => {
    if (!pollId) return true

    // A question this page holds no strip for is an arrival and needs the
    // whole page; one the strip already names is a crossing, and the poll
    // around it is already on screen and correct. That is the difference
    // between the two reads below, and it is about the strip rather than
    // about which question was read last: every question of a poll answers
    // with the whole group, so arriving at any of them covers all of them.
    if (!covered.current.includes(pollId)) {
      const { page, error: readError } = await readPollPage(pollId)

      if (readError || !page || page.kind === 'unreadable') {
        // Only a first read that fails says anything about the link, and this
        // is one. Reached by the sample, whose file holds no such question,
        // and by a poll that stopped being readable while somebody was
        // walking through it: `PollPage` establishes the rest before this page
        // is ever rendered, and sends a signed-out reader to the sign-in
        // screen rather than here.
        if (loadedFor.current !== pollId) {
          setFailed({ pollId, message: readError ?? 'Poll not found.' })
        }
        return false
      }
      if (page.kind === 'open') {
        finish(pollId, page.view, page.questions, page.results, page.ballots)
        return true
      }
    }

    const { data, error: rpcError } = await openPollRpc('open_poll_view', {
      p_poll_id: pollId,
      p_voter_key: voterKeyFor(pollId),
    })
    // A read that failed and a read that came back the wrong shape are the
    // same event here, and get the same handling: a later read keeps the poll
    // already on screen, because turning a page somebody has been voting on
    // into "poll not found" over one lost request would be a lie about their
    // link. Only a first read says anything.
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
  }, [pollId, finish])

  // This question's own view. Null while a read for it is still in flight,
  // which is what stops the question being left from rendering under the
  // address of the question being opened.
  const view = read && read.pollId === pollId ? read.view : null
  // And its tally, on the same terms and from the same read: a card drawn
  // from the question being left would be the wrong numbers under the right
  // heading. Null on every read that did not bring one, which is `Results`
  // reading for itself.
  const results = read && read.pollId === pollId ? read.results : null
  const ballots = read && read.pollId === pollId ? read.ballots : null
  // The poll around the question, and the reason the two are separated at
  // all. Every question in a group shares the poll's title, its description
  // and its terms, so a read of any of them describes the poll — and the
  // strip below the heading is the same list whichever question is open. So
  // while this question's ballot is being read, the poll it belongs to stays
  // on screen rather than blinking away and back, which is exactly what a
  // reader is doing when they cross between questions: using the strip.
  //
  // Only within one poll, though: a pollId this page holds no group for is a
  // different poll, and the last poll's heading is not a stand-in for it.
  const sibling =
    read &&
    questions.some((question) => question.id === read.pollId) &&
    questions.some((question) => question.id === pollId)
      ? read.view
      : null
  const shell = view ?? sibling
  const error = failed && failed.pollId === pollId ? failed.message : null

  // The poll's other questions arrive with the poll itself: `poll_page`
  // answers the same list for every question in the group, so crossing between
  // them asks the server for nothing and the strip stays on screen while it
  // happens.
  const known = questions.some((question) => question.id === pollId)

  const sample = !!pollId && isSampleId(pollId)

  // Handed up to the route, which owns the subscription. Registered for as
  // long as this page is on screen, a settled poll included: an open poll
  // whose results are out has taken its last vote, but its creator can still
  // reset it, and a reset is the one thing a page that had stopped listening
  // would not hear. See useLiveStream.
  useEffect(() => {
    watch(load)
    return () => watch(null)
  }, [watch, load])

  // The sample watches nothing — it is answered out of a file in this browser,
  // so the route holds no topic for it and no signal is ever coming — so it
  // reads for itself. Once: the file cannot change under it, and a vote cast
  // in it re-reads through `load` like any other.
  useEffect(() => {
    if (sample) void load()
  }, [sample, load])

  if (!pollId || error) {
    return (
      <Stack maw={720} mx="auto" gap="md" align="center">
        <Title order={3}>Poll not found</Title>
        <Text c="dimmed" ta="center">
          This link may be mistyped, or the poll may have been deleted.
        </Text>
      </Stack>
    )
  }

  // Nothing read yet, of this poll or of any question in it. A crossing
  // between two questions of one poll never lands here: `shell` is what the
  // last question read, and it describes this one too.
  if (!shell) return <PollPageSkeleton />

  // The poll's questions as the strip draws them, built once: the strip
  // renders this and the way on is chosen from it, so the question a voter is
  // carried to is by construction one the strip in front of them shows as
  // outstanding rather than one that merely ought to agree.
  //
  // What counts as done depends on the stage: a poll still collecting its
  // options has no ballots to have cast, so the mark is this browser's
  // confirmation of that question's list, and the ballot's once there is one.
  // The same badge either way, of whatever the reader currently owes.
  const collecting = shell.soliciting
  const done = collecting ? confirmed : answered
  // Whether the poll has stopped taking answers, which decides two things at
  // once. The strip marks nothing: a poll that has closed, or whose results
  // are out, takes no more ballots, so which questions this browser answered
  // is a distinction about a vote nobody can still cast, and undefined marks
  // neither way; see QuestionStrip. And the question's half of the page stops
  // being one card with the strip inside it and becomes the strip with a
  // tally or a notice under it, which is where the stand-in below has to put
  // it too. The invite reading draws both lines on the same fact.
  const finished = shell.is_closed || shell.results_available
  const marking = !finished
  const strip = questions.map((question) => ({
    key: question.id,
    position: question.question_position,
    title: question.question_title,
    answered: marking ? done.has(question.id) : undefined,
  }))
  // How many questions the poll asks, for the count badge: a poll of several
  // has no turnout, only turnouts, so the badge says how much there is to
  // answer instead. See turnoutLabel. The strip arrives with the poll, so
  // `known` is true wherever there is a poll on screen to put a badge on, and
  // a poll with no group asks one question.
  const questionCount = !shell.poll.group_id ? 1 : known ? questions.length : 1
  const onwards = nextUnansweredKey(strip, pollId)
  // The way on, taken rather than offered, at both stages: whoever has just
  // finished with this question's list or ballot is carried to the next one
  // they owe. Recorded here as well as in `load`, because this path is the
  // one that does not re-read: the page being left is left at once, and the
  // strip on the page being opened has to know what went in.
  const advance = onwards
    ? () => {
        ;(collecting ? rememberConfirmed : rememberAnswered)(pollId)
        navigate(`/polls/${onwards}`)
      }
    : undefined
  // One strip for the page, built here rather than inside the panel's prop,
  // because the panel is not the only thing that draws it: the stand-in a
  // crossing puts up carries the same strip, in the same place, so the way
  // between the poll's questions is never the part that is waiting. The
  // invite reading keeps it in one place for the same reason.
  const questionStrip = (
    <>
      <QuestionStrip questions={strip} current={pollId} hrefFor={(next) => `/polls/${next}`} />
      {strip.length > 1 && <Divider />}
    </>
  )
  // And whether the question being opened will ask for a name, which the
  // stand-in has to know because the box is the first thing in the card. The
  // same three facts the card itself goes on: a poll that names its
  // respondents, still taking answers, from a reader who has not given this
  // question one yet. Nothing is guessed — `done` is this browser's own
  // record and the rest is the poll's.
  const asksName = shell.poll.show_voters && marking && !done.has(pollId)

  return (
    <Stack maw={720} mx="auto" gap="md">
      <LiveConnectionNotice status={live} />

      {/* The same heading the signed-in poll page and the poll list carry,
          for the reason PollHeading exists: one poll should not be two
          different-looking things depending on how you reached it.

          One of its four parts is knowingly left out: who created the poll.
          Every email address this app shows is shown to somebody already in
          the poll it belongs to, and a share link has no such boundary.

          The terms are stated in full, the count included, and before this
          reader has voted: what a poll keeps from its voters is how it is
          *going* — the standings, sealed until the results unlock — and how
          many have answered is not that. It names nobody. */}
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
          // Out of `shell`, which is the same read that drew the heading this
          // badge sits beside — so during a crossing between questions the
          // two describe the same question, and neither can be a step ahead
          // of the other.
          //
          // It used to be taken out of the tally the card below fetched for
          // itself, because `poll_winners()` answers only to an account and
          // this page has none. That made the badge wait on that card and
          // exist only because it did. `open_poll_view` carries the answer
          // now, so it arrives with the page and needs no account to ask for.
          winner: shell.winner_settled ? (shell.winner_name ?? null) : undefined,
          // Except on a poll of several questions, whose badge names none of
          // their winners. See PollStateBadge.
          inGroup: !!shell.poll.group_id,
        }}
      />

      {/* Everything below the strip belongs to one question rather than to
          the poll, so it is the only part that waits: a crossing keeps the
          heading and the strip and fills this in, instead of blinking the
          whole poll away and back at the moment the strip is being used. */}
      {view ? (
        <>
          {/* A first ballot opens the question this voter still owes, in
              place of the card that used to sit at the foot of this page
              offering to. A voter working through a poll of five wants the
              next one, every time; asking five times whether they would like
              what they came for is four presses and a scroll each, and the
              one press that answered it was never a decision. Which question
              that is comes from lib/nextQuestion.ts, including what happens
              when the answer is none. Changing a vote does not advance — that
              is a deliberate trip back to a question already behind them, and
              carrying them forward again would undo it. */}
          <OpenPollPanel
            pollId={pollId}
            view={view}
            results={results}
            ballots={ballots}
            onChanged={load}
            onFirstVote={advance}
            onFirstConfirm={advance}
            voterName={voterName}
            questionStrip={questionStrip}
          />
        </>
      ) : (
        // The strip and the name box go in for real rather than as two more
        // shapes: both are the poll's, like the heading above, and only
        // happen to live inside the card being replaced. See QuestionSkeleton.
        //
        // No `tallied` and no row count, unlike the account reading, and
        // neither is an omission. An open question has no invite list to have
        // finished, so `poll_gate_open` has nothing but `closed_at` to go on
        // and a finished one here was always closed — which settles the group
        // at whatever it had, so a question nobody answered is a real ending
        // and the one card both endings share is all this can claim. And the
        // strip a share link is given carries no option count: see
        // `open_poll_group` for what that list deliberately leaves out.
        <QuestionSkeleton
          finished={finished}
          nameField={asksName ? <VoterNameField name={voterName} /> : undefined}
          strip={questionStrip}
        />
      )}
    </Stack>
  )
}
