import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Stack, Text, Title } from '@mantine/core'
import { isSampleToken, openPollRpc } from '../lib/samplePoll'
import { voterKeyFor } from '../lib/voterKey'
import { shareTopic, useLiveStream } from '../lib/useLiveStream'
import { useKnownWinner } from '../lib/useWinner'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { NextQuestion } from '../components/NextQuestion'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { PollHeading } from '../components/PollHeading'
import { QuestionStrip } from '../components/QuestionStrip'
import { PollPageSkeleton } from '../components/Skeletons'
import type { OpenGroupQuestion, OpenPollView } from '../lib/types'

/**
 * The /p/:token route: an open poll seen by someone who is not signed in,
 * and may never be. It renders inside the ordinary app shell: landing here
 * is how plenty of people first meet the site, and the header is what tells
 * them there is a site, with the way to sign in on it.
 */
export function PublicPoll() {
  const { token } = useParams<{ token: string }>()
  const [view, setView] = useState<OpenPollView | null>(null)
  const [questions, setQuestions] = useState<OpenGroupQuestion[]>([])
  const [error, setError] = useState<string | null>(null)
  // Whether a read has ever come back, so a refresh that fails can be told
  // apart from a first read that did. A ref rather than `view` itself,
  // which would put the poll in load()'s dependencies.
  const loaded = useRef(false)

  // The whole poll, read once here and handed to the panel below: this page
  // needs the title and the tags, the panel needs everything else, and one
  // copy, re-read on one signal, is what keeps them agreeing.
  const load = useCallback(async () => {
    if (!token) return true
    const { data, error: rpcError } = await openPollRpc('open_poll_view', {
      p_token: token,
      p_voter_key: voterKeyFor(token),
    })
    if (rpcError) {
      // Only a first read that fails says anything about the link. A later
      // one keeps the poll already on screen; turning a page somebody has
      // been voting on into "poll not found" because one request lost a
      // race with a flaky connection would be a lie about their link.
      if (!loaded.current) setError(rpcError.message)
      return false
    }
    loaded.current = true
    setView(data as OpenPollView)
    return true
  }, [token])

  // The poll's other questions, with the share token of each. Read once per
  // question rather than on the live tick: which questions a poll asks is
  // frozen at creation, and this side has nothing per-reader in it — an open
  // poll's ballots are deliberately not linkable across questions, so there
  // is no "answered" flag here to keep up to date. See open_poll_group.
  const groupId = view?.poll.group_id
  useEffect(() => {
    if (!token || !groupId) {
      setQuestions([])
      return
    }
    let cancelled = false
    openPollRpc('open_poll_group', { p_token: token }).then(({ data, error: rpcError }) => {
      // Swallowed like the winner lookup on the list: a browser running
      // ahead of the migration gets no strip, and a poll with no strip is a
      // poll of one question.
      if (rpcError || !data || cancelled) return
      setQuestions(data as OpenGroupQuestion[])
    })
    return () => {
      cancelled = true
    }
  }, [token, groupId])

  // This page can subscribe before it has read anything, because the poll is
  // announced under its share token as well as under its id and the token is
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
  const sample = !!token && isSampleToken(token)
  const liveStatus = useLiveStream(token ? [shareTopic(token)] : [], load, {
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
  const winner = useKnownWinner(view?.poll.id)

  if (!token || error) {
    return (
      <Stack gap="xs" align="center" maw={720} mx="auto">
        <Title order={3}>Poll not found</Title>
        <Text c="dimmed" ta="center">
          This link may be mistyped, or the poll may have been deleted.
        </Text>
      </Stack>
    )
  }

  if (!view) return <PollPageSkeleton />

  const here = questions.findIndex((question) => question.token === token)
  const nextQuestion = here >= 0 && here < questions.length - 1 ? questions[here + 1] : null

  return (
    <Stack gap="lg" maw={720} mx="auto">
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
        title={view.poll.title}
        description={view.poll.description}
        createdBy={null}
        mode={view.poll.mode}
        showVoters={view.poll.show_voters}
        showBallots={view.poll.show_ballots}
        turnout={{
          soliciting: view.soliciting,
          mode: view.poll.mode,
          votedCount: view.voted_count,
          invitedCount: 0,
          optionCount: view.options.length,
        }}
        state={{
          soliciting: view.soliciting,
          resultsAvailable: view.results_available,
          closed: view.is_closed,
          winner,
          // The answer is coming from the card below rather than from a
          // request of this page's own, so "still loading" here is simply
          // "the card has not filed one yet" — and the badge stays off until
          // it does, instead of saying the results are ready and then
          // rewriting itself into the name. If that card fails there is no
          // badge at all, which is the honest end of the same rule: it says
          // so itself, in red, where the tally would have been.
          awaitingWinner: view.results_available && winner === undefined,
        }}
      />

      {/* The rest of the poll, reached by the tokens open_poll_group hands
          back to whoever already holds one of them. No question is marked
          answered here, and that is the design rather than an omission: an
          open ballot is identified by a key minted per question so that one
          browser's ballots cannot be joined to each other, and the server is
          not asked to undo that for a tick. */}
      <QuestionStrip
        questions={questions.map((question) => ({
          key: question.token,
          position: question.question_position,
          title: question.question_title,
        }))}
        current={token}
        hrefFor={(next) => `/p/${next}`}
      />

      {/* What this question asks; the heading above carries the poll's own
          title, which every question shares. */}
      {view.poll.question_title && <Title order={3}>{view.poll.question_title}</Title>}

      <OpenPollPanel token={token} view={view} onChanged={load} />

      {/* Offered once this browser's ballot is in, which open_poll_view knows
          for this question because it was shown the key that cast it. It
          knows nothing about the other questions and is not asked to. */}
      {nextQuestion && view.voted && (
        <NextQuestion title={nextQuestion.question_title} href={`/p/${nextQuestion.token}`} />
      )}
    </Stack>
  )
}
