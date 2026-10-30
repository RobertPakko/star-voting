import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { Button, Card, Group, Stack, Text } from '@mantine/core'
import { PencilSimpleIcon } from '@phosphor-icons/react'
import { useAuth } from '../lib/auth'
import { isSampleId, openPollRpc } from '../lib/samplePoll'
import { forgetWatch, usePushHere, useWatching, watchPoll } from '../lib/push'
import { openPollViewSchema, parseAnswer } from '../lib/rpcSchemas'
import { voterKeyFor } from '../lib/voterKey'
import type { DraftScope } from '../lib/ballotDraft'
import type { VoterName } from '../lib/voterName'
import { BallotCard } from './BallotCard'
import type { BallotScore } from './BallotFrame'
import { CollectOptions, Confirmations } from './CollectOptions'
import { Ballots, Results, TimeBallotCard, YourBallot } from './deferred'
import { NameRoster } from './NameRoster'
import { NoResultsNotice, RevealNote } from './PollNotices'
import { BallotsSkeleton, QuestionSkeleton, ResultsSkeleton, YourBallotSkeleton } from './Skeletons'
import { SmoothHeight } from './SmoothHeight'
import { VoterNameField } from './VoterNameField'
import { Banners } from './Banners'
import type { BallotSheet, OpenPollView, PollOption, PollResults } from '../lib/types'

/**
 * An open poll at every stage -- collecting, voting, results -- through the
 * anon RPCs. Used on the public page and on the creator's own page, so the
 * creator votes exactly as everyone else does. The page owns and re-reads the
 * view; this renders it and reports back.
 */
export function OpenPollPanel({
  pollId,
  view,
  results = null,
  ballots = null,
  isCreator = false,
  voterName,
  onChanged,
  onFirstVote,
  onFirstConfirm,
  questionStrip,
  removed,
  onRestored,
}: {
  pollId: string
  view: OpenPollView
  /** The tally, when `poll_page` carried it. */
  results?: PollResults | null
  /** The published sheet, likewise. */
  ballots?: BallotSheet | null
  /** The name to answer under, held by the page; only asked where the poll shows respondents. */
  voterName?: VoterName
  /** The creator reading their own open poll: option removal and second-person wording. */
  isCreator?: boolean
  /** A ballot went in, or the option list moved: the page re-reads the poll. */
  onChanged: () => void
  /**
   * A first ballot went in (not a revision), so a multi-question poll can move
   * on. Replaces `onChanged` on that path; absent where there is nowhere to go.
   */
  onFirstVote?: () => void
  /** The same for a first confirmation of the option list. */
  onFirstConfirm?: () => void
  /** Drawn inside the card where there is one, above the tally where there isn't. */
  questionStrip?: ReactNode
  /** Whether the reader removed the poll from their list; see `Banners`. */
  removed?: boolean
  onRestored?: () => void
}) {
  // A share link has no account, so a poll that shows respondents asks for a
  // name; one that hides them stores none whatever is sent.
  const needsName = view.poll.show_voters
  const schedule = view.poll.kind === 'time' ? view.poll.schedule : null

  // Watches are filed per group, so every question agrees. See lib/push.ts.
  const watchKey = view.poll.group_id ?? pollId
  // The creator runs the poll, and the sample has nobody to send anything.
  const canWatch = !isCreator && !isSampleId(pollId)
  const finished = view.results_available || view.is_closed

  // A signed-in account that answers is in the poll's audience already (see
  // poll_answering_accounts), so it files no watch. An anonymous session has
  // no address to be in an audience by, so it watches like a signed-out reader.
  const { session, anonymous } = useAuth()
  const signedIn = !!session && !anonymous

  // The creator runs the poll, and the sample is reached from the home page.
  const banners = canWatch ? (
    <Banners pollId={pollId} removed={removed} onRestored={onRestored} />
  ) : null

  // With link push on, file a watch on any answered poll not yet watched --
  // at the vote, or on the next visit for one answered earlier. Failures are
  // ignored; the next visit retries.
  const pushHere = usePushHere(undefined)
  const watching = useWatching(watchKey)
  const answered = view.soliciting ? !!view.confirmed : view.voted
  useEffect(() => {
    if (!canWatch || signedIn || !pushHere || finished || !answered || watching) return
    watchPoll(pollId, watchKey).catch(() => {})
  }, [canWatch, signedIn, pushHere, finished, answered, watching, pollId, watchKey])

  // The database dropped the watch at the results; drop the mirror too.
  useEffect(() => {
    if (finished) forgetWatch(watchKey)
  }, [finished, watchKey])

  if (view.soliciting) {
    return (
      <Stack gap="md">
        <CollectOptions
          source={{ kind: 'open', pollId }}
          options={view.options}
          schedule={schedule}
          isCreator={isCreator}
          voterName={needsName ? voterName : undefined}
          questionStrip={questionStrip}
          confirm={{
            confirmed: view.confirmed,
            // An open poll has no participant list, so no confirmation
            // can be the last one; its creator ends the stage.
            opensWhenEveryoneHas: false,
          }}
          onChanged={onChanged}
          onConfirmed={onFirstConfirm ?? onChanged}
        />

        {view.confirmations && <Confirmations names={view.confirmations} />}

        {view.confirmed && banners}
      </Stack>
    )
  }

  // Names only; the count is in the header badge. Null when respondents are hidden.
  const participation = view.voters ? (
    <NameRoster title="Voters" names={view.voters} empty="Nobody has voted yet." />
  ) : null

  if (view.results_available) {
    return (
      <Stack gap="md">
        {questionStrip}
        <Suspense fallback={<ResultsSkeleton options={view.options.length || undefined} />}>
          <Results
            source={{ kind: 'open', pollId }}
            meeting={
              view.poll.kind === 'time' && view.poll.schedule
                ? { title: view.poll.title, schedule: view.poll.schedule }
                : null
            }
            initial={results}
          />
        </Suspense>
        {participation}
        {/* Where ballots are private, the reader's own, from `your_scores`. */}
        {!view.poll.show_ballots && view.voted && view.your_scores && (
          <Suspense
            fallback={
              <YourBallotSkeleton rows={view.options.length || undefined} schedule={schedule} />
            }
          >
            <YourBallot
              pollId={pollId}
              options={view.options}
              scores={view.your_scores}
              schedule={schedule}
            />
          </Suspense>
        )}
        {view.poll.show_ballots && (
          <Suspense
            fallback={<BallotsSkeleton rows={view.voted_count || undefined} schedule={schedule} />}
          >
            <Ballots
              source={{ kind: 'open', pollId }}
              title={view.poll.title}
              question={view.poll.question_title}
              initial={ballots}
              schedule={schedule}
            />
          </Suspense>
        )}
      </Stack>
    )
  }

  if (view.is_closed) {
    return (
      <Stack gap="md">
        {questionStrip}
        <NoResultsNotice inGroup={!!view.poll.group_id} />
      </Stack>
    )
  }

  // Only the card that swaps moves its height: the roster under it is pushed
  // down as it grows, rather than sitting inside the clip and being uncovered.
  return (
    <Stack gap="md">
      <SmoothHeight>
        {view.voted ? (
          <Voted
            pollId={pollId}
            view={view}
            isCreator={isCreator}
            voterName={needsName ? voterName : undefined}
            onRevised={onChanged}
            questionStrip={questionStrip}
            banner={banners}
          />
        ) : (
          <OpenBallot
            pollId={pollId}
            poll={view.poll}
            options={view.options}
            voterName={needsName ? voterName : undefined}
            isCreator={isCreator}
            onVoted={onFirstVote ?? onChanged}
            questionStrip={questionStrip}
          />
        )}
      </SmoothHeight>

      {participation}
    </Stack>
  )
}

/**
 * "Your vote is in", and the ballot behind it when changing. Only rendered
 * while results are sealed, which is the window `open_poll_revise` accepts.
 */
function Voted({
  pollId,
  view,
  isCreator,
  voterName,
  onRevised,
  questionStrip,
  banner,
}: {
  pollId: string
  view: OpenPollView
  isCreator: boolean
  /** Drawn disabled, showing the name on the ballot; Edit vote opens it again. */
  voterName?: VoterName
  onRevised: () => void
  questionStrip?: ReactNode
  banner?: ReactNode
}) {
  const { session } = useAuth()
  const [revising, setRevising] = useState<Record<string, number> | null>(null)
  const [fetching, setFetching] = useState(false)
  // Without scores in hand, offer no Edit rather than an empty ballot that
  // would overwrite real ones.
  const scores = view.your_scores

  // Signed out, only this browser's key reaches the ballot, so the scores in
  // hand are current. Signed in, another device may have changed it (silently),
  // so re-read first, falling back to what is in hand.
  const edit = async () => {
    if (!scores) return
    // The box starts from the name on the ballot, which is what a correction corrects.
    if (voterName && view.your_name) voterName.onChange(view.your_name)
    if (!session) {
      setRevising(scores)
      return
    }
    setFetching(true)
    const { data, error } = await openPollRpc('open_poll_view', {
      p_poll_id: pollId,
      p_voter_key: voterKeyFor(pollId),
    })
    setFetching(false)
    const fresh =
      !error && data ? parseAnswer(openPollViewSchema, 'open_poll_view', data).value : null
    setRevising(fresh?.your_scores ?? scores)
  }

  if (revising) {
    return (
      <OpenBallot
        pollId={pollId}
        poll={view.poll}
        options={view.options}
        initial={revising}
        voterName={voterName}
        isCreator={isCreator}
        onVoted={() => {
          setRevising(null)
          onRevised()
        }}
        onCancel={() => setRevising(null)}
        questionStrip={questionStrip}
      />
    )
  }

  return (
    <Stack gap="md">
      <Card withBorder>
        <Stack gap="sm">
          {/* Kept on the card, so the strip under it doesn't move between questions. */}
          {voterName && <VoterNameField name={voterName} disabled value={view.your_name ?? ''} />}
          {questionStrip}
          <Stack gap={2}>
            <Text fw={500}>Your vote is in</Text>
            <Group justify="space-between" wrap="wrap" gap="sm">
              <RevealNote reveal={{ kind: 'open', isCreator }} canRevise={!!scores} />
              {scores && (
                <Button
                  variant="light"
                  loading={fetching}
                  onClick={() => void edit()}
                  leftSection={<PencilSimpleIcon size={16} aria-hidden />}
                  style={{ marginLeft: 'auto' }}
                >
                  Edit vote
                </Button>
              )}
            </Group>
          </Stack>
        </Stack>
      </Card>
      {banner}
    </Stack>
  )
}

/**
 * An open poll's ballot, new or being changed. `BallotCard`/`TimeBallotCard`
 * draws it; this adds the name and the voter-key RPCs. A revision sends the name
 * too, so a misspelt one can be put right.
 */
function OpenBallot({
  pollId,
  poll,
  options,
  voterName,
  isCreator,
  initial,
  onVoted,
  onCancel,
  questionStrip,
}: {
  pollId: string
  poll: Pick<OpenPollView['poll'], 'kind' | 'schedule' | 'group_id'>
  options: PollOption[]
  /** Absent on polls that don't ask. */
  voterName?: VoterName
  isCreator: boolean
  /** The scores already on this ballot; absent when casting one. */
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
    : { pollId, groupId: poll.group_id ?? null, owner: session?.user.id ?? null }

  // Closing a phone keyboard doesn't blur the field, so every star tap would
  // pop it back up. Drop focus as the tap starts.
  function releaseNameFocus() {
    voterName?.blur()
  }

  function checkName() {
    return !voterName || voterName.check('Enter your name so the group can see who has voted.')
  }

  async function send(scores: BallotScore[]) {
    const { error } = revising
      ? await openPollRpc('open_poll_revise', {
          p_poll_id: pollId,
          p_scores: scores,
          p_voter_key: voterKeyFor(pollId),
          p_voter_name: voterName?.trimmed,
        })
      : await openPollRpc('open_poll_submit', {
          p_poll_id: pollId,
          p_scores: scores,
          p_voter_key: voterKeyFor(pollId),
          p_voter_name: voterName?.trimmed ?? null,
        })
    if (error) throw new Error(error.message)
  }

  if (poll.kind === 'time' && poll.schedule) {
    return (
      <Suspense
        fallback={
          <QuestionSkeleton
            schedule={poll.schedule}
            nameField={voterName && <VoterNameField name={voterName} />}
            strip={questionStrip}
          />
        }
      >
        <TimeBallotCard
          options={options}
          schedule={poll.schedule}
          initial={initial}
          draft={draft}
          nameField={voterName && <VoterNameField name={voterName} />}
          questionStrip={questionStrip}
          note={<RevealNote reveal={{ kind: 'open', isCreator }} canRevise />}
          beforeSubmit={checkName}
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
      nameField={voterName && <VoterNameField name={voterName} />}
      questionStrip={questionStrip}
      note={<RevealNote reveal={{ kind: 'open', isCreator }} canRevise />}
      beforeSubmit={checkName}
      onSubmit={send}
      onVoted={onVoted}
      onCancel={onCancel}
      onScorePointerDown={releaseNameFocus}
    />
  )
}
