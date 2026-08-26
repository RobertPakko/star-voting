import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Card, Divider, Group, Progress, Stack, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { pollTopic, useLiveStream } from '../lib/useLiveStream'
import { useWinner } from '../lib/useWinner'
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
import { Ballots } from '../components/Ballots'
import { BallotCard, type BallotScore } from '../components/BallotCard'
import { CollectOptions } from '../components/CollectOptions'
import { CreatorControls } from '../components/CreatorControls'
import { LiveConnectionNotice } from '../components/LiveConnectionNotice'
import { OpenPollPanel } from '../components/OpenPollPanel'
import { NoResultsNotice, RevealNote } from '../components/PollNotices'
import { PollHeading } from '../components/PollHeading'
import { QuestionStrip } from '../components/QuestionStrip'
import { RetentionNote } from '../components/RetentionNote'
import { PollPageSkeleton, QuestionSkeleton } from '../components/Skeletons'
import { countBadge } from '../lib/badgeColors'
import { Respondents } from '../components/Respondents'
import { Results } from '../components/Results'
import type { GroupQuestion, OpenPollView, Poll, PollOption, PollStatus } from '../lib/types'

/**
 * A poll read as an account: the creator's own, or one they were invited to.
 *
 * It is reached through `PollPage`, which hands every poll address to this
 * first and falls back to the public reading when this says it cannot see the
 * poll. That is what `onUnreadable` is for, and why the failure is reported
 * rather than drawn: an open poll's link now goes to the same address for
 * everybody, so "no row came back" no longer means "no such poll" -- it means
 * this reader is not in the poll, which for an open one is no obstacle at all.
 */
export function PollDetail({ onUnreadable }: { onUnreadable: () => void }) {
  const { pollId } = useParams<{ pollId: string }>()
  const { session } = useAuth()
  const navigate = useNavigate()
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
  // Which questions this browser has answered, and which it has finished
  // adding options to, for the strip's marks on an *open* poll. `poll_group`
  // answers both for an invite poll and can answer neither for an open one —
  // it matches ballots and confirmations on `voter_id`, and a share-link
  // ballot carries no account — so the creator's own page had the same
  // unmarked strip the public route did. See lib/questionMarks.ts.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(answeredQuestions)
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(confirmedQuestions)
  // Which question everything above describes. One page serves every question
  // of a poll and its parameter is what changes between them, so for as long
  // as a read is in flight "the poll this page holds" and "the poll this page
  // is showing" are two different questions. What they share — the poll's
  // title, its terms, the strip of questions — is drawn from what is held;
  // the ballot, which is the part that differs, waits for this to agree. See
  // where it is used below.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
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
      supabase.from('polls').select('*').eq('id', pollId).maybeSingle(),
      supabase.from('candidates').select('*').eq('poll_id', pollId).order('sort_order'),
      supabase.rpc('poll_status', { p_poll_id: pollId }).single(),
      supabase.rpc('poll_group', { p_poll_id: pollId }),
    ])

    // No row and no error is row-level security answering precisely: the poll
    // exists or it does not, but either way it is not this account's to read.
    // `PollPage` takes it from here -- an open poll is readable by anyone
    // holding the link, and this reader is holding it.
    if (!pollRes.error && !pollRes.data) {
      onUnreadable()
      return true
    }

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

    if (loaded.mode === 'open') {
      const { data, error: viewError } = await supabase.rpc('open_poll_view', {
        p_poll_id: loaded.id,
        p_voter_key: voterKeyFor(loaded.id),
      })
      if (viewError) {
        setError(viewError.message)
        setLoading(false)
        return false
      }
      const openView = data as OpenPollView
      setView(openView)
      // The public reading of this same question is at this same address and
      // marks the same entries, so a question answered — or finished with —
      // either way is marked both ways without either page knowing about the
      // other. Erased as well as written: a confirmation can be taken back,
      // and a creator can clear a poll's votes, so a read that comes back
      // "no" is what stops a stale mark outliving what it stood for.
      if (openView.voted) rememberAnswered(loaded.id)
      else forgetAnswered(loaded.id)
      if (openView.confirmed) rememberConfirmed(loaded.id)
      else forgetConfirmed(loaded.id)
      setAnswered(answeredQuestions())
      setConfirmed(confirmedQuestions())
    }

    loadedOnce.current = true
    setLoadedFor(pollId)
    setLoading(false)
    return true
  }, [pollId, onUnreadable])

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

    const openId = poll?.mode === 'open' ? poll.id : null
    const [statusRes, viewRes, optionsRes] = await Promise.all([
      supabase.rpc('poll_status', { p_poll_id: pollId }).single(),
      openId
        ? supabase.rpc('open_poll_view', { p_poll_id: openId, p_voter_key: voterKeyFor(openId) })
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
  }, [pollId, poll?.mode, poll?.id, optionsMayMove])

  // What a signal on this poll means, which depends on whether this page has
  // ever read it: the whole poll the first time, and only the parts that can
  // move on every one after that. Navigating from one question to another
  // remounts nothing — the poll around them is the same page and must not
  // blink — so the flag is cleared alongside the poll it describes, in the
  // effect below.
  const onSignal = useCallback(async () => {
    if (loadedOnce.current) return refresh()
    return load()
  }, [load, refresh])

  // Moving to another question of the same poll remounts nothing — that is
  // the point, since the heading and the strip belong to the poll and must
  // not blink — so the two things that are about the question rather than the
  // poll are cleared by hand on the way across. The flag, because the
  // question being opened has not been read even though the last one had; and
  // a ballot half-changed in the question being left, which would otherwise
  // turn up in the next one scored against a different list of options.
  useEffect(() => {
    loadedOnce.current = false
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
  // Whether everything read above is about the question in the address bar.
  // False only while a crossing between two questions of one poll is in
  // flight, and what it gates is the ballot: the heading, the terms and the
  // strip are the poll's rather than the question's, so they are already
  // right for the question being opened and stay put. See `loadedFor`.
  const showing = loadedFor === pollId
  // ...and only within one poll. A poll this page holds no group for is a
  // different poll rather than another question of this one, and the last
  // poll's heading is no stand-in for it: that is a page load, not a
  // crossing. A poll asking one question has an empty group, so arriving at
  // one from the list always lands here.
  if (!showing && !questions.some((question) => question.id === pollId)) {
    return <PollPageSkeleton />
  }
  // The poll's questions as the strip draws them, built once so that the way
  // on is chosen from the same list the voter is looking at. `questions` is
  // empty on a poll that asks a single question, so there is no strip and no
  // way on, and nothing about the page changes. Answered comes from the
  // server for an invite poll and from this browser for an open one — where
  // each can honestly answer; see QuestionStrip.
  //
  // What counts as done depends on the stage, because the strip marks the
  // question a reader has finished with and a poll still collecting has no
  // ballots to have cast. So it is the confirmation while the list is being
  // built and the ballot afterwards — the same badge, of whatever the reader
  // currently owes. `confirmed` is undefined against a database whose
  // poll_group predates it, which marks nothing, exactly as every strip did
  // before the flag existed.
  const done = status.soliciting
    ? { browser: confirmed, server: (question: GroupQuestion) => question.confirmed === true }
    : { browser: answered, server: (question: GroupQuestion) => question.voted }
  const strip = questions.map((question) => ({
    key: question.id,
    position: question.question_position,
    title: question.question_title,
    answered: isOpen ? done.browser.has(question.id) : done.server(question),
  }))
  // One strip for the page rather than one per branch that can draw a
  // question. Every branch below renders it — the option list, a first
  // ballot, a ballot being changed, the card a voter comes back to, the
  // tally, and the notice a question closed empty puts up — because every one
  // of them is a place a reader can be left standing, and a poll of several
  // questions that offers no way to the others is a dead end wherever it
  // happens. It is the same navigation in all of them, so a copy per branch
  // was a chance per branch to hand one of them a different list.
  const questionStrip = (
    <>
      <QuestionStrip
        questions={strip}
        current={pollId ?? poll.id}
        hrefFor={(id) => `/polls/${id}`}
      />
      {strip.length > 1 && <Divider />}
    </>
  )
  // The way on, taken rather than offered: a first ballot opens whichever
  // question this reader still owes. Undefined when they owe none and on a
  // poll of one, where the ballot's own page is where they stay and the page
  // re-reads itself into "your vote is in" as it always did. See
  // lib/nextQuestion.ts for which question that is and why it rounds.
  const onwards = nextUnansweredKey(strip, poll.id)
  const advance = onwards
    ? () => {
        // This path does not re-read the question being left, so nothing else
        // will record what was just done in it; the strip on the page being
        // opened needs it recorded to mark this question behind them. Which
        // mark is whichever the stage is about, as above.
        if (isOpen) (status.soliciting ? rememberConfirmed : rememberAnswered)(poll.id)
        navigate(`/polls/${onwards}`)
      }
    : undefined
  // One option list for this page. An open poll's arrives inside its view,
  // which is what its ballot is scored from; every other poll's is the table
  // read directly. The heading counts it and the option editor edits it, and
  // neither should have to know which poll it is looking at.
  const optionList = isOpen ? (view?.options ?? []) : options
  // The way to say you are done adding, on an invite poll that is still
  // collecting. Three things have to be true and none of them is cosmetic:
  //
  //  - the reader is on the **invite list**. Only invitees confirm, exactly as
  //    only invitees vote, which is what keeps the roster complete — everyone
  //    who can confirm is on it. A creator who did not invite themselves says
  //    "I am done" with *Open poll*, which they have had all along.
  //  - the poll is **collecting**, since a confirmation is about a list that
  //    can still grow and means nothing once it is a ballot.
  //  - the database **knows what a confirmation is**. This app deploys on push
  //    and its migrations apply on merge, so `confirmed` arrives undefined
  //    against a database one merge behind; offering a button that could only
  //    fail would be worse than offering none.
  //
  // How many have confirmed is not passed down: that is the count badge's job,
  // in the header, on every screen this poll appears on. What is passed is
  // whether this press could be the one that opens the poll, which is the part
  // of it the button cannot show by itself.
  const confirmation =
    !isOpen && status.soliciting && status.invited && status.confirmed !== undefined
      ? {
          confirmed: status.confirmed,
          opensWhenEveryoneHas:
            status.confirmed_count !== undefined &&
            status.invited_count > 0 &&
            status.confirmed_count < status.invited_count,
        }
      : undefined

  return (
    <Stack maw={720} mx="auto" gap="md">
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
          // From poll_status either way: it counts invitees who have confirmed
          // on an invite poll and browsers that have on an open one, which is
          // the same split the badge's denominator makes.
          confirmedCount: status.confirmed_count,
          optionCount: optionList.length,
          // What the same poll's card on the list says, from the same count:
          // a poll of several questions has no turnout, only turnouts, so the
          // badge reports how much there is to answer instead. See
          // turnoutLabel. `questions` is empty on a poll that asks one, and
          // list_polls counts that poll as one question rather than none.
          questionCount: questions.length || 1,
        }}
        state={{
          soliciting: status.soliciting,
          resultsAvailable: status.results_available,
          closed: status.is_closed,
          winner,
          awaitingWinner,
        }}
      />

      {/* One question's worth of the page, and the only part that waits on a
          crossing between two of them: what the question asks, and the ballot
          that answers it. Everything above belongs to the poll and is the
          same whichever question is open, so it stays on screen rather than
          blinking away and back at the moment the strip is being used to
          navigate. */}
      {showing ? (
        <>
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
              questionStrip={questionStrip}
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
                pollId={poll.id}
                view={view}
                isCreator={isCreator}
                onChanged={load}
                onFirstVote={advance}
                onFirstConfirm={advance}
                questionStrip={questionStrip}
              />
            )
          ) : status.soliciting ? (
            /* No ballot yet: the poll is a list everyone in it can add to, and
           the creator decides when it becomes a ballot. */
            <CollectOptions
              source={{ kind: 'poll', pollId: poll.id }}
              options={options}
              isCreator={isCreator}
              questionStrip={questionStrip}
              confirm={confirmation}
              onChanged={reloadAll}
              onConfirmed={advance}
            />
          ) : status.results_available ? (
            /* The strip sits above the tally rather than inside it, which is
               the one place in this page it is not inside a card — because
               here there is no one card for it to be inside, and because a
               tally still loading, or a read of it that failed, must not take
               the way out of the question with it. Everything else about it
               is unchanged: the same list, in the same order, marking the
               same questions. */
            <>
              {questionStrip}
              <Results source={{ kind: 'poll', pollId: poll.id }} pollId={poll.id} />
            </>
          ) : status.is_closed ? (
            <>
              {questionStrip}
              <NoResultsNotice inGroup={!!poll.group_id} />
            </>
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
                questionStrip={questionStrip}
              />
            ) : (
              <Waiting
                status={status}
                pollId={poll.id}
                onRevise={setRevising}
                questionStrip={questionStrip}
              />
            )
          ) : (
            /* Keyed like the open-poll panel, and for the same reason: a
           correction to the option list invalidates a half-filled ballot,
           and remounting is what discards it. */
            <VoteForm
              key={refreshKey}
              poll={poll}
              options={options}
              onVoted={advance ?? load}
              questionStrip={questionStrip}
            />
          )}
        </>
      ) : (
        <QuestionSkeleton />
      )}

      {/* Everyone in the poll, for as long as the poll shows them: a poll that
          says it shows who has responded shows it, and there is no second
          rule about when. It used to be held back until you had voted, on the
          reasoning that watching a roster fill up is a live feed of the
          arrival order — but that made one card behave two ways depending on
          who was reading it and how far through they were, and the same card
          now also answers who has confirmed the options, which nothing about
          ballots can sensibly embargo. One setting decides, and it is the
          setting that says so on the tag beside the title.

          Whether there is anything to draw is `show_voters` or being the
          creator, who keeps the list either way because for them it is the
          invite list they manage. Anyone else on a poll that hides its
          respondents gets no card and no heading over it — the header's count
          badge has said how many and the tag has said why nobody is named. */}
      {!isOpen && (poll.show_voters || isCreator) && (
        <Stack gap={2}>
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

      {/* Only the invite side asks here. An open poll's ballots are already
          on this page, drawn by OpenPollPanel from the link's own endpoint —
          the panel is the whole of an open poll wherever it is read, this
          page included, and a second grid under it was a second answer to a
          question already answered. */}
      {!isOpen && status.results_available && poll.show_ballots && (
        <Ballots source={{ kind: 'poll', pollId: poll.id }} />
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
 *
 * It carries the question strip, in the same place inside the card as every
 * other card on this page does — because this is the card a voter in a poll
 * of several questions spends the most time looking at. Answering question 3
 * of five lands here, and without the strip the poll would have taken its
 * ballot and left the reader on a card with nowhere to go: the two questions
 * they still owe are one tap away and nothing on screen said so. The open
 * poll's own "your vote is in" card has carried it all along; see `Voted` in
 * OpenPollPanel, which this is the invite side's twin of.
 */
function Waiting({
  status,
  pollId,
  onRevise,
  questionStrip,
}: {
  status: PollStatus
  pollId: string
  /** The ballot came back: hand it to the page, which puts the form up. */
  onRevise: (scores: Record<string, number>) => void
  /** Navigation for a multi-question ballot, rendered inside its card. */
  questionStrip?: ReactNode
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
            loading={loading}
            style={{ marginLeft: 'auto' }}
          >
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
 * The ballot on screen is `BallotCard`, the same one an open poll puts up;
 * what is here is where this one's scores go. Signed in, so there is nobody
 * to name and no key to carry: `submit_ballot` and `revise_ballot` know who
 * is voting, and `initial` is the whole of the difference between them.
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
  initial,
  onVoted,
  onCancel,
  questionStrip,
}: {
  poll: Pick<Poll, 'id'>
  options: PollOption[]
  /** The scores already on this voter's ballot; absent when casting a new one. */
  initial?: Record<string, number>
  /** The ballot is in: re-read the poll so this page becomes the wait. */
  onVoted: () => void
  /** Offered only when changing a vote; leaves the ballot as it stands. */
  onCancel?: () => void
  /** Navigation for a multi-question ballot, rendered inside its card. */
  questionStrip?: ReactNode
}) {
  const revising = initial !== undefined

  async function send(scores: BallotScore[]) {
    const { error } = await supabase.rpc(revising ? 'revise_ballot' : 'submit_ballot', {
      p_poll_id: poll.id,
      p_scores: scores,
    })
    if (error) throw new Error(error.message)
  }

  return (
    <BallotCard
      options={options}
      initial={initial}
      questionStrip={questionStrip}
      note={<RevealNote reveal={{ kind: 'invite' }} canRevise />}
      onSubmit={send}
      onVoted={onVoted}
      onCancel={onCancel}
    />
  )
}
