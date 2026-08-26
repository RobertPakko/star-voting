import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Divider, Stack, Text, Title } from '@mantine/core'
import { isSampleId, openPollRpc } from '../lib/samplePoll'
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
import { pollTopic, useLiveStream } from '../lib/useLiveStream'
import { useKnownWinner } from '../lib/useWinner'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { PollHeading } from '../components/PollHeading'
import { QuestionStrip } from '../components/QuestionStrip'
import { PollPageSkeleton, QuestionSkeleton } from '../components/Skeletons'
import type { OpenGroupQuestion, OpenPollView } from '../lib/types'

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
 * When even that read fails it says so upward as well as on screen, because
 * the two readers it can fail for want different things. A signed-in one has
 * now been refused both ways and the link really is dead, which is what the
 * card below says. A signed-out one has been told only that the poll is not
 * public -- it may be an invite poll they are on the list for, which is what
 * every invitation email links to -- so `PollPage` offers them the sign-in
 * screen instead of a dead end.
 */
export function PublicPoll({ onUnreadable }: { onUnreadable: () => void }) {
  const { pollId } = useParams<{ pollId: string }>()
  const navigate = useNavigate()
  // The most recent read, and which question it was of, held as one value so
  // the two cannot drift. A poll of several questions is served by one page
  // whose parameter changes, so "the view" and "the view of what is on screen"
  // are different things for as long as a read is in flight.
  const [read, setRead] = useState<{ pollId: string; view: OpenPollView } | null>(null)
  const [questions, setQuestions] = useState<OpenGroupQuestion[]>([])
  // Which question the group read has come back for, whatever it came back
  // with. A failure is an answer too — it is swallowed, like the winner
  // lookup on the list, and what it leaves is a poll with no strip, which is
  // a poll of one question — so the count badge below stops waiting on it
  // rather than staying blank for the life of the page. Compared against the
  // address rather than held as a flag, so it clears itself on the way to a
  // different poll.
  const [groupRead, setGroupRead] = useState<string | null>(null)
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

  // The whole poll, read once here and handed to the panel below: this page
  // needs the title and the tags, the panel needs everything else, and one
  // copy, re-read on one signal, is what keeps them agreeing.
  const load = useCallback(async () => {
    if (!pollId) return true
    const { data, error: rpcError } = await openPollRpc('open_poll_view', {
      p_poll_id: pollId,
      p_voter_key: voterKeyFor(pollId),
    })
    if (rpcError) {
      // Only a first read that fails says anything about the link. A later
      // one keeps the poll already on screen; turning a page somebody has
      // been voting on into "poll not found" because one request lost a
      // race with a flaky connection would be a lie about their link.
      if (loadedFor.current !== pollId) {
        setFailed({ pollId, message: rpcError.message })
        onUnreadable()
      }
      return false
    }
    loadedFor.current = pollId
    const openView = data as OpenPollView
    setRead({ pollId, view: openView })
    // Erased rather than only written: a creator who clears the poll's votes
    // leaves this browser holding a record of a ballot that no longer exists,
    // a confirmation can be taken back on the card that gave it, and a read
    // that comes back "no" is what says so.
    if (openView.voted) rememberAnswered(pollId)
    else forgetAnswered(pollId)
    if (openView.confirmed) rememberConfirmed(pollId)
    else forgetConfirmed(pollId)
    setAnswered(answeredQuestions())
    setConfirmed(confirmedQuestions())
    return true
  }, [pollId, onUnreadable])

  // This question's own view. Null while a read for it is still in flight,
  // which is what stops the question being left from rendering under the
  // address of the question being opened.
  const view = read && read.pollId === pollId ? read.view : null
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

  // The poll's other questions, with the share pollId of each. Read once per
  // poll rather than once per question, and never on the live tick: which
  // questions a poll asks is frozen at creation, and this side has nothing
  // per-reader in it — an open poll's ballots are deliberately not linkable
  // across questions, so there is no "answered" flag here to keep up to date.
  // See open_poll_group, which answers the same list for every pollId in the
  // group; that is what makes crossing between them free, and free is what
  // keeps the strip on screen while it happens.
  const groupId = shell?.poll.group_id
  const known = questions.some((question) => question.id === pollId)
  useEffect(() => {
    if (known) return
    if (!pollId || !groupId) {
      setQuestions([])
      return
    }
    let cancelled = false
    openPollRpc('open_poll_group', { p_poll_id: pollId }).then(({ data, error: rpcError }) => {
      // Swallowed like the winner lookup on the list: a browser running
      // ahead of the migration gets no strip, and a poll with no strip is a
      // poll of one question.
      if (cancelled) return
      if (!rpcError && data) setQuestions(data as OpenGroupQuestion[])
      setGroupRead(pollId)
    })
    return () => {
      cancelled = true
    }
  }, [pollId, groupId, known])

  // This page can subscribe before it has read anything, because the poll is
  // announced under its share pollId as well as under its id and the pollId is
  // in the URL. That is the whole reason for the second topic: without it
  // this page would have to read the poll to learn its id, and then read it
  // again on subscribing to close the gap in between.
  //
  // A closed poll takes no more votes, and one whose results are out has
  // stopped moving, so the watching stops with it. Before the first read
  // there is nothing to stop for: that read is what the subscription is for.
  //
  // The sample poll is answered out of a file in this browser, so there is
  // nothing on the other end of a subscription to it and nothing that could
  // ever change: it is the one open poll on this page that is never watched.
  const live = !view || (!view.is_closed && !view.results_available)
  const sample = !!pollId && isSampleId(pollId)
  const liveStatus = useLiveStream(pollId ? [pollTopic(pollId)] : [], load, {
    enabled: live && !sample,
  })

  // Subscribing is also what makes every other poll's first read happen, so
  // the sample -- which subscribes to nothing -- reads for itself. Once: the
  // file it is answered from cannot change under it, and a vote cast in it
  // re-reads through `load` like any other.
  useEffect(() => {
    if (sample) void load()
  }, [sample, load])

  // What the tally below this heading elected, read out of the browser rather
  // than asked for: the Results card fetches that tally for itself and files
  // the winner under the poll, so the badge costs no request. It asks nobody,
  // because `poll_winners()` answers only to an account and this page has
  // none.
  // Of the poll on screen, which during a crossing is still the question
  // being left — the heading below is drawn from the same `shell`, so the
  // badge and the poll it sits beside always describe the same question.
  const winner = useKnownWinner(shell?.poll.id)

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
  const strip = questions.map((question) => ({
    key: question.id,
    position: question.question_position,
    title: question.question_title,
    answered: done.has(question.id),
  }))
  // How many questions the poll asks, for the count badge: a poll of several
  // has no turnout, only turnouts, so the badge says how much there is to
  // answer instead. See turnoutLabel.
  //
  // Zero means "not known yet" rather than "none", and the badge is left off
  // entirely until it is. The group arrives in a read behind this page, so a
  // poll that has one would otherwise draw a turnout and rewrite itself into
  // *5 questions* a moment later — the same thing the winner badge below
  // waits to avoid. `known` is what says the list in hand is this poll's and
  // not the last one's; a poll with no group asks one question and is
  // answered immediately, and a group read that came back with nothing
  // usable is answered the same way, because that is the poll it leaves.
  const questionCount = !shell.poll.group_id
    ? 1
    : known
      ? questions.length
      : groupRead === pollId
        ? 1
        : 0
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

  return (
    <Stack maw={720} mx="auto" gap="md">
      <LiveConnectionNotice status={liveStatus} />

      {/* The same heading the signed-in poll page and the poll list carry,
          for the reason PollHeading exists: one poll should not be two
          different-looking things depending on how you reached it.

          One of its four parts is left out here, and knowingly: who created
          the poll. Every email address this app shows anywhere is shown to
          somebody already in the poll it belongs to, and a share link has no
          such boundary — it reaches whoever it was forwarded to.

          Someone arriving from a shared link has no other context at all, so
          the terms of the poll are stated in full, not just the one that
          changes what happens to their ballot. The count included, and before
          this reader has voted: what a poll keeps from its voters is how it
          is *going*, the standings, which stay sealed until the results
          unlock, and how many have answered is not that. It names nobody, it
          says nothing about any ballot, and the roster below still waits. */}
      <PollHeading
        title={shell.poll.title}
        description={shell.poll.description}
        createdBy={null}
        mode={shell.poll.mode}
        showVoters={shell.poll.show_voters}
        showBallots={shell.poll.show_ballots}
        turnout={
          questionCount === 0
            ? undefined
            : {
                soliciting: shell.soliciting,
                mode: shell.poll.mode,
                votedCount: shell.voted_count,
                invitedCount: 0,
                confirmedCount: shell.confirmed_count,
                optionCount: shell.options.length,
                questionCount,
              }
        }
        state={{
          soliciting: shell.soliciting,
          resultsAvailable: shell.results_available,
          closed: shell.is_closed,
          winner,
          // The answer is coming from the card below rather than from a
          // request of this page's own, so "still loading" here is simply
          // "the card has not filed one yet" — and the badge stays off until
          // it does, instead of saying the results are ready and then
          // rewriting itself into the name. If that card fails there is no
          // badge at all, which is the honest end of the same rule: it says
          // so itself, in red, where the tally would have been.
          awaitingWinner: shell.results_available && winner === undefined,
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
            onChanged={load}
            onFirstVote={advance}
            onFirstConfirm={advance}
            questionStrip={
              <>
                <QuestionStrip
                  questions={strip}
                  current={pollId}
                  hrefFor={(next) => `/polls/${next}`}
                />
                {strip.length > 1 && <Divider />}
              </>
            }
          />
        </>
      ) : (
        <QuestionSkeleton />
      )}
    </Stack>
  )
}
