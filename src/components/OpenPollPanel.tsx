import { useRef, useState } from 'react'
import { Badge, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { openPollRpc } from '../lib/samplePoll'
import { VOTER_NAME_MAX } from '../lib/limits'
import { voterKeyFor } from '../lib/voterKey'
import { useBallotOrder } from '../lib/ballotOrder'
import { rememberVoterName, rememberedVoterName } from '../lib/voterName'
import { badgeColor } from '../lib/badgeColors'
import { Ballots } from './Ballots'
import { CollectOptions } from './CollectOptions'
import { Confirmations, ConfirmOptions } from './ConfirmOptions'
import { OptionDescription } from './OptionDescription'
import { Results } from './Results'
import { StarRating } from './StarRating'
import type { OpenPollView, PollOption } from '../lib/types'

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
  isCreator = false,
  onChanged,
  onFirstVote,
}: {
  pollId: string
  view: OpenPollView
  /** Creators see participation before voting; see where it's rendered. */
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
}) {
  // Before anything else, because a poll still collecting its options has no
  // ballot to show and no result to show either.
  if (view.soliciting) {
    return (
      <Stack gap="md">
        <CollectOptions
          source={{ kind: 'open', pollId }}
          options={view.options}
          isCreator={isCreator}
          footer={
            <Text size="sm" c="dimmed">
              {isCreator
                ? 'Voting hasn’t started. Everyone can add options until you open the poll.'
                : 'Voting hasn’t started. Everyone can add options until the poll’s creator opens the poll.'}
            </Text>
          }
          confirm={
            // Undefined against a database whose open_poll_view predates the
            // field, and then there is no button rather than one that could
            // only fail; the same rule `your_scores` follows for "Edit vote".
            view.confirmed === undefined ? undefined : (
              <ConfirmOptions
                source={{ kind: 'open', pollId }}
                confirmed={view.confirmed}
                confirmedName={view.your_confirmed_name}
                // A share link has no account to name whoever is confirming,
                // so a poll that shows its respondents asks for a name here
                // exactly as its ballot does. One that hides them asks for
                // none and stores none.
                needsName={view.poll.show_voters}
                // No denominator: an open poll has no list of people, so
                // there is no set of them to have all confirmed and nothing
                // this count can reach. Its creator ends the stage.
                progress={
                  view.confirmed_count === undefined
                    ? undefined
                    : { confirmed: view.confirmed_count }
                }
                onChanged={onChanged}
              />
            )
          }
          onChanged={onChanged}
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
  // the header badge above, once, on every screen the poll appears on.
  //
  // Held back until you have voted, because watching a roster fill up is a
  // live feed of the arrival order, names attached to the moment each one
  // arrived, which is what the published ballots work to keep off the
  // record by ordering themselves on a hash instead of on time. The count on
  // its own carries no name and is not withheld anywhere.
  //
  // Two exemptions. The creator, because the roster is what "close voting
  // now" gets decided on and a creator who isn't voting could never earn the
  // view. And a poll whose results are out, because the reason for the
  // embargo is that a ballot might still be cast, and on that poll none can.
  //
  // A poll that hides respondents renders nothing here at all: it has no
  // names to show, and the header has already said how many and why.
  const participation =
    view.voters && (view.voted || isCreator || view.results_available) ? (
      <VoterList voters={view.voters} final={view.results_available} />
    ) : null

  if (view.results_available) {
    return (
      <Stack gap="md">
        <Results source={{ kind: 'open', pollId }} pollId={view.poll.id} />
        {/* Gated in the database on the same terms as the results, so this
            condition only decides whether to ask. */}
        {participation}
        {view.poll.show_ballots && <Ballots source={{ kind: 'open', pollId }} />}
      </Stack>
    )
  }

  if (view.is_closed) {
    return (
      <Card withBorder>
        {/* Closing acts on the whole poll, so one question of several can end
            with nothing in it while the rest have results. */}
        <Text fw={500}>
          {view.poll.group_id
            ? 'The poll was closed before anyone answered this question, so it has no results.'
            : 'This poll was closed before anyone voted, so there are no results.'}
        </Text>
      </Card>
    )
  }

  return (
    <Stack gap="md">
      {view.voted ? (
        <Voted pollId={pollId} view={view} isCreator={isCreator} onRevised={onChanged} />
      ) : (
        <OpenBallot
          pollId={pollId}
          options={view.options}
          needsName={view.poll.show_voters}
          showBallots={view.poll.show_ballots}
          onVoted={onFirstVote ?? onChanged}
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
}: {
  pollId: string
  view: OpenPollView
  isCreator: boolean
  /** A changed ballot went in: the page re-reads the poll. */
  onRevised: () => void
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
        needsName={false}
        showBallots={view.poll.show_ballots}
        initial={scores}
        onVoted={() => {
          setRevising(false)
          onRevised()
        }}
        onCancel={() => setRevising(false)}
      />
    )
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Text fw={500}>Your vote is in</Text>
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 220 }}>
            {isCreator
              ? 'Results are revealed once you close the poll.'
              : 'Results are revealed once the poll is closed by its creator.'}
            {scores && (
              <>
                <br />
                You can change your vote until then.
              </>
            )}
          </Text>
          {scores && (
            <Button variant="light" onClick={() => setRevising(true)}>
              Edit vote
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  )
}

/**
 * Who has voted, on a poll that names them.
 *
 * "So far" is a promise that the list is still moving, and on a poll whose
 * results are out it is not: every ballot that will ever be cast is in it,
 * and the roster is a record rather than a progress report. The heading says
 * whichever of the two this poll is.
 */
function VoterList({ voters }: { voters: string[]; final: boolean }) {
  return (
    <Stack gap="xs">
      <Title order={4}>Voters</Title>
      <Card withBorder>
        {voters.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nobody has voted yet.
          </Text>
        ) : (
          <Group gap="xs">
            {voters.map((name) => (
              <Badge key={name} variant="light" color={badgeColor.done}>
                {name}
              </Badge>
            ))}
          </Group>
        )}
      </Card>
    </Stack>
  )
}

/**
 * The ballot behind a share link, filled in for the first time or filled in
 * again.
 *
 * One form for both, as on the invite side. The difference a revision makes
 * is that the stars start where the voter left them and the scores go to
 * `open_poll_revise`; the name field is gone, because a name on an open poll
 * is already on the roster everyone else is reading and `open_poll_revise`
 * will not change it. What somebody is changing is their vote, which is the
 * only part of that ballot nobody has seen.
 */
function OpenBallot({
  pollId,
  options,
  needsName,
  initial,
  onVoted,
  onCancel,
}: {
  pollId: string
  options: PollOption[]
  needsName: boolean
  showBallots: boolean
  /** The scores already on this browser's ballot; absent when casting one. */
  initial?: Record<string, number>
  onVoted: () => void
  /** Offered only when changing a vote; leaves the ballot as it stands. */
  onCancel?: () => void
}) {
  const revising = initial !== undefined
  // Shown in this browser's own order rather than the creator's; see
  // lib/ballotOrder.ts. The scores below are keyed by option id, so this
  // changes what the voter reads and nothing about what they send.
  const ballot = useBallotOrder(options)
  // Offered rather than imposed: a name this browser has voted under before,
  // editable like any other, and blank for a browser that has not. It is what
  // lets a poll of several questions be answered without typing the same name
  // onto every one of them — the questions are separate polls and nothing on
  // the server connects one ballot to the next, deliberately, so the
  // continuity has to come from the only place that legitimately has it. See
  // lib/voterName.ts.
  const [name, setName] = useState(rememberedVoterName)
  const [values, setValues] = useState<Record<string, number>>(initial ?? {})
  const [submitting, setSubmitting] = useState(false)
  // The name is the one thing on this ballot that can be wrong, so it is
  // marked on the box rather than as a line above the submit button, where
  // it sat below the field it was about.
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  /**
   * Dismissing the on-screen keyboard on a phone does not blur the field it
   * belongs to, so focus never moves off the name box on its own. Left alone,
   * every score a voter gives pops the keyboard back up over the ballot.
   * Dropping focus as the tap starts, before the browser decides whether to
   * re-open the keyboard, leaves the stars tappable in peace.
   *
   * The same blur is what Enter needs: the name field stands alone rather than
   * in a form, so there is nothing for Enter to submit and the keyboard simply
   * stays up. See the key handler on the field.
   */
  function releaseNameFocus() {
    nameRef.current?.blur()
  }

  function setScore(optionId: string, score: number) {
    setValues((prev) => ({ ...prev, [optionId]: score }))
  }

  async function handleSubmit() {
    setError(null)
    setNameError(null)

    const trimmedName = name.trim()
    if (needsName && !trimmedName) {
      setNameError('Enter your name so the group can see who has voted.')
      nameRef.current?.focus()
      return
    }

    setSubmitting(true)
    const scores = ballot.map((o) => ({ candidate_id: o.id, score: values[o.id] ?? 0 }))
    const { error: rpcError } = revising
      ? await openPollRpc('open_poll_revise', {
          p_poll_id: pollId,
          p_scores: scores,
          p_voter_key: voterKeyFor(pollId),
        })
      : await openPollRpc('open_poll_submit', {
          p_poll_id: pollId,
          p_scores: scores,
          p_voter_key: voterKeyFor(pollId),
          p_voter_name: needsName ? trimmedName : null,
        })
    setSubmitting(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    // Remembered only once a ballot has actually gone in under it, so a name
    // typed into a form that was refused is not offered back on the next one.
    if (needsName) rememberVoterName(trimmedName)
    notifications.show({ message: revising ? 'Vote updated' : 'Vote submitted', color: 'green' })
    onVoted()
  }

  return (
    <Stack gap="md">
      {needsName && (
        <TextInput
          ref={nameRef}
          label="Your name"
          placeholder="Your name"
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value)
            setNameError(null)
          }}
          error={nameError}
          maxLength={VOTER_NAME_MAX}
          required
          /* Label the key "Done" rather than a Go/newline the field has no use
             for, and honour that label by putting the keyboard away. */
          enterKeyHint="done"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            releaseNameFocus()
          }}
        />
      )}

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
              onPointerDown={releaseNameFocus}
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
