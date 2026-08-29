import { Suspense, useState, type ReactNode } from 'react'
import { Button, Card, Group, Stack, Text } from '@mantine/core'
import { openPollRpc } from '../lib/samplePoll'
import { voterKeyFor } from '../lib/voterKey'
import type { VoterName } from '../lib/voterName'
import { BallotCard, type BallotScore } from './BallotCard'
import { CollectOptions, Confirmations } from './CollectOptions'
import { Ballots, Results } from './deferred'
import { NameRoster } from './NameRoster'
import { NoResultsNotice, RevealNote } from './PollNotices'
import { BallotsSkeleton, ResultsSkeleton } from './Skeletons'
import { VoterNameField } from './VoterNameField'
import type { BallotSheet, OpenPollView, PollOption, PollResults } from '../lib/types'

/**
 * The whole voting experience for an open poll, driven by the poll's id --
 * which, on an open poll, is the link.
 *
 * Used twice: for people who never sign in, and inside the creator's own
 * poll page so they can vote in their own poll without going through the
 * link. Both go through the same anon-callable RPCs, so there is one code
 * path and one set of rules.
 *
 * It covers every stage an open poll can be in, because every one of them
 * is reached through the same link: collecting options, taking votes, and
 * showing the result.
 *
 * The view is handed in rather than fetched here. Both pages already read
 * it, they render the poll's title and tags around this panel, and both
 * now re-read it whenever the database says it moved, so fetching it here as
 * well would mean two copies of the same poll on one screen, answering the
 * same signal separately and free to disagree about whether it has closed.
 * The page owns the poll; this renders it and reports a vote back.
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
}: {
  pollId: string
  view: OpenPollView
  /**
   * The tally, when the page above already has it — handed down for the same
   * reason `view` is, and by the same route: `poll_page` brings it on a poll
   * whose results are out, so the card below draws it rather than asking for
   * it a round trip later. Null everywhere else, which is where that card has
   * always started. See 0050 and `Results`.
   */
  results?: PollResults | null
  /** The published ballot sheet, handed down for the same reason. */
  ballots?: BallotSheet | null
  /**
   * The name this browser is answering under, held by the page. A share link
   * carries no account, so a poll that shows its respondents has to ask for
   * one — on the ballot and on the card the option list is confirmed from,
   * which is why this is handed to both from here rather than kept in either.
   * A poll that names nobody asks for nothing and is handed nothing; see
   * VoterNameField for why the page is what holds it.
   */
  voterName?: VoterName
  /**
   * The creator reading their own open poll. It buys them the `×` on each
   * option while the list is still being collected, and the second person in
   * the sentences below — "once you close the poll" rather than "once the
   * poll's creator does". It no longer buys an early look at the roster,
   * because nobody's is late any more; see `participation`.
   */
  isCreator?: boolean
  /** A ballot went in, or the option list moved: the page re-reads the poll. */
  onChanged: () => void
  /**
   * A *first* ballot went in from this browser, as against a changed one.
   * Offered so a poll of several questions can move the voter on to the next
   * one, which is the whole of what a voter does next; a revision is a
   * deliberate return to a question already behind them and moving them on
   * from it would undo the trip they made.
   *
   * It **replaces** `onChanged` on that path rather than joining it: the page
   * that takes this is leaving the question, and a re-read of the question
   * being left would land after the next one had loaded. Absent on the last
   * question and on a poll that asks one, where there is nowhere to go and
   * re-reading is exactly right.
   */
  onFirstVote?: () => void
  /**
   * The same, one stage earlier: a *first* confirmation of this question's
   * option list, as against one taken back. A poll of several questions
   * collects a list for each, so the reader who has finished with this one is
   * moved to the next list they owe exactly as a first ballot moves them to
   * the next question. Absent where there is nowhere to go.
   */
  onFirstConfirm?: () => void
  /**
   * Navigation between the poll's questions, drawn at every stage this panel
   * can be in. Inside the card wherever there is one card — the option list,
   * the ballot, the card a voter comes back to — and above the block where
   * there is not, which is the tally.
   */
  questionStrip?: ReactNode
}) {
  // Whether this poll asks a name at all, which is the one rule both stages
  // apply: a share link has no account to name whoever is answering, so a
  // poll that shows its respondents asks, and one that hides them asks for
  // none and stores none. `open_poll_submit` and `open_poll_confirm_options`
  // both discard the name on such a poll whatever the client sends.
  const needsName = view.poll.show_voters

  // Before anything else, because a poll still collecting its options has no
  // ballot to show and no result to show either. It carries the strip the
  // ballot carries, in the same place: a poll of several questions collects a
  // list for each of them, so this stage needs the way between them exactly
  // as the next one does.
  if (view.soliciting) {
    return (
      <Stack gap="md">
        <CollectOptions
          source={{ kind: 'open', pollId }}
          options={view.options}
          isCreator={isCreator}
          voterName={needsName ? voterName : undefined}
          questionStrip={questionStrip}
          confirm={
            // Undefined against a database whose open_poll_view predates the
            // field, and then there is no button rather than one that could
            // only fail; the same rule `your_scores` follows for "Edit vote".
            view.confirmed === undefined
              ? undefined
              : {
                  confirmed: view.confirmed,
                  // Never: an open poll has no list of people, so there is no
                  // set of them who could all have confirmed and no press that
                  // could be the last one. Its creator ends the stage. How many
                  // have is in the count badge above, like everywhere else.
                  opensWhenEveryoneHas: false,
                }
          }
          onChanged={onChanged}
          onConfirmed={onFirstConfirm ?? onChanged}
        />

        {/* Who is done, on a poll that names them. No embargo, unlike the
            voter roster below: what that one withholds is the order ballots
            arrived in, and a poll still collecting its options has no ballots
            to attach an order to. Knowing who has finished is the whole point
            of the stage. */}
        {view.confirmations && <Confirmations names={view.confirmations} />}
      </Stack>
    )
  }

  // Who has voted, on a poll that names them. Only the names: how many is in
  // the header badge, once, on every screen the poll appears on.
  //
  // One condition and no second one. It was once held back until you had
  // voted, because watching a roster fill up is a live feed of the arrival
  // order — but that bought a narrower version of a leak it could not close (a
  // voter still sees everyone arriving after them) at the price of one card
  // behaving three ways. A poll that says it shows who has responded shows it,
  // to everyone in it, whichever stage it is at; one that hides them renders
  // nothing here, and the header has already said how many and why.
  const participation = view.voters ? (
    <NameRoster title="Voters" names={view.voters} empty="Nobody has voted yet." />
  ) : null

  if (view.results_available) {
    return (
      <Stack gap="md">
        {/* Above the tally rather than inside it, which is the one place this
            strip is not inside a card — there is no one card here for it to
            be inside, and a tally still loading, or a read of it that failed,
            must not take the way out of the question with it. The invite
            reading places it the same way, for the same reason. */}
        {questionStrip}
        <Suspense fallback={<ResultsSkeleton options={view.options.length || undefined} />}>
          <Results source={{ kind: 'open', pollId }} initial={results} />
        </Suspense>
        {/* Gated in the database on the same terms as the results, so this
            condition only decides whether to ask. */}
        {participation}
        {view.poll.show_ballots && (
          <Suspense fallback={<BallotsSkeleton rows={view.voted_count || undefined} />}>
            <Ballots source={{ kind: 'open', pollId }} initial={ballots} />
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

  return (
    <Stack gap="md">
      {view.voted ? (
        <Voted
          pollId={pollId}
          view={view}
          isCreator={isCreator}
          onRevised={onChanged}
          questionStrip={questionStrip}
        />
      ) : (
        <OpenBallot
          pollId={pollId}
          options={view.options}
          voterName={needsName ? voterName : undefined}
          isCreator={isCreator}
          onVoted={onFirstVote ?? onChanged}
          questionStrip={questionStrip}
        />
      )}

      {participation}
    </Stack>
  )
}

/**
 * The card someone who has voted through the link comes back to, and the
 * ballot behind it when they want it changed.
 *
 * Everything it needs is already here: `open_poll_view` hands this browser
 * its own scores back alongside the poll, reached with the same voter_key
 * that had to be held to cast them, so changing a vote costs no request until
 * there is a changed vote to send. This is only ever rendered while the
 * results are still sealed — the branch above returns before it otherwise —
 * which is the same window `open_poll_revise` will accept a change in.
 */
function Voted({
  pollId,
  view,
  isCreator,
  onRevised,
  questionStrip,
}: {
  pollId: string
  view: OpenPollView
  isCreator: boolean
  /** A changed ballot went in: the page re-reads the poll. */
  onRevised: () => void
  questionStrip?: ReactNode
}) {
  const [revising, setRevising] = useState(false)
  // A database that predates `your_scores` returns undefined, and a ballot
  // that cannot be handed back is a ballot that cannot be changed. Better to
  // offer nothing than a button that opens an empty ballot and silently
  // zeroes what somebody scored.
  const scores = view.your_scores

  if (revising && scores) {
    return (
      <OpenBallot
        pollId={pollId}
        options={view.options}
        initial={scores}
        isCreator={isCreator}
        onVoted={() => {
          setRevising(false)
          onRevised()
        }}
        onCancel={() => setRevising(false)}
        questionStrip={questionStrip}
      />
    )
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        {questionStrip}
        <Stack gap={2}>
          <Text fw={500}>Your vote is in</Text>
          <Group justify="space-between" wrap="wrap" gap="sm">
            <RevealNote reveal={{ kind: 'open', isCreator }} canRevise={!!scores} />
            {scores && (
              <Button
                variant="light"
                onClick={() => setRevising(true)}
                style={{ marginLeft: 'auto' }}
              >
                Edit vote
              </Button>
            )}
          </Group>
        </Stack>
      </Stack>
    </Card>
  )
}

/**
 * The ballot behind a share link, filled in for the first time or filled in
 * again.
 *
 * Everything a voter touches is `BallotCard`, which is the same card the
 * invite side puts up; what is here is what an open poll's ballot alone has
 * to deal with. That is the name — a share link carries no account, so a poll
 * that shows who has responded has to ask — and the RPCs it goes to, which
 * take a voter key in place of one.
 *
 * The name field is gone from a revision, because a name on an open poll is
 * already on the roster everyone else is reading and `open_poll_revise` will
 * not change it. What somebody is changing is their vote, which is the only
 * part of that ballot nobody has seen.
 */
function OpenBallot({
  pollId,
  options,
  voterName,
  isCreator,
  initial,
  onVoted,
  onCancel,
  questionStrip,
}: {
  pollId: string
  options: PollOption[]
  /** The name to vote under, on the polls that ask; absent on a revision. */
  voterName?: VoterName
  isCreator: boolean
  /** The scores already on this browser's ballot; absent when casting one. */
  initial?: Record<string, number>
  onVoted: () => void
  /** Offered only when changing a vote; leaves the ballot as it stands. */
  onCancel?: () => void
  questionStrip?: ReactNode
}) {
  const revising = initial !== undefined

  /**
   * Dismissing the on-screen keyboard on a phone does not blur the field it
   * belongs to, so focus never moves off the name box on its own. Left alone,
   * every score a voter gives pops the keyboard back up over the ballot.
   * Dropping focus as the tap starts, before the browser decides whether to
   * re-open the keyboard, leaves the stars tappable in peace.
   */
  function releaseNameFocus() {
    voterName?.blur()
  }

  /**
   * The one thing to be happy about before any of this is sent. The name is
   * the one thing on this ballot that can be wrong, so it is marked on the
   * box rather than as a line above the submit button, where it sat below the
   * field it was about.
   */
  function checkName() {
    return !voterName || voterName.check('Enter your name so the group can see who has voted.')
  }

  async function send(scores: BallotScore[]) {
    const { error } = revising
      ? await openPollRpc('open_poll_revise', {
          p_poll_id: pollId,
          p_scores: scores,
          p_voter_key: voterKeyFor(pollId),
        })
      : await openPollRpc('open_poll_submit', {
          p_poll_id: pollId,
          p_scores: scores,
          p_voter_key: voterKeyFor(pollId),
          p_voter_name: voterName?.trimmed ?? null,
        })
    if (error) throw new Error(error.message)
    // Remembered only once a ballot has actually gone in under it, so a name
    // typed into a form that was refused is not offered back on the next one.
    voterName?.remember()
  }

  return (
    <BallotCard
      options={options}
      initial={initial}
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
