import { useRef, useState } from 'react'
import { Badge, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { VOTER_NAME_MAX } from '../lib/limits'
import { voterKeyFor } from '../lib/voterKey'
import { badgeColor } from '../lib/badgeColors'
import { Ballots } from './Ballots'
import { CollectOptions } from './CollectOptions'
import { OptionDescription } from './OptionDescription'
import { Results } from './Results'
import { StarRating } from './StarRating'
import type { OpenPollView, PollOption } from '../lib/types'

/**
 * The whole voting experience for an open poll, driven by the share token.
 *
 * Used twice: on the public /p/:token route for people who never sign in,
 * and inside the creator's own poll page so they can vote in their own poll
 * without going through the link. Both go through the same anon-callable
 * RPCs, so there is one code path and one set of rules.
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
  token,
  view,
  isCreator = false,
  onChanged,
}: {
  token: string
  view: OpenPollView
  /** Creators see participation before voting; see where it's rendered. */
  isCreator?: boolean
  /** A ballot went in, or the option list moved: the page re-reads the poll. */
  onChanged: () => void
}) {
  // Before anything else, because a poll still collecting its options has no
  // ballot to show and no result to show either.
  if (view.soliciting) {
    return (
      <CollectOptions
        source={{ kind: 'token', token }}
        options={view.options}
        isCreator={isCreator}
        footer={
          <Text size="sm" c="dimmed">
            {isCreator
              ? 'Voting hasn’t started. Everyone can add options until you open the poll.'
              : 'Voting hasn’t started. Everyone can add options until the poll’s creator opens the poll.'}
          </Text>
        }
        onChanged={onChanged}
      />
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
      <Stack gap="lg">
        <Results source={{ kind: 'token', token }} pollId={view.poll.id} />
        {/* Gated in the database on the same terms as the results, so this
            condition only decides whether to ask. */}
        {participation}
        {view.poll.show_ballots && <Ballots source={{ kind: 'token', token }} />}
      </Stack>
    )
  }

  if (view.is_closed) {
    return (
      <Card withBorder>
        <Text fw={500}>This poll was closed before anyone voted, so there are no results.</Text>
      </Card>
    )
  }

  return (
    <Stack gap="md">
      {view.voted ? (
        <Voted token={token} view={view} isCreator={isCreator} onRevised={onChanged} />
      ) : (
        <OpenBallot
          token={token}
          options={view.options}
          needsName={view.poll.show_voters}
          showBallots={view.poll.show_ballots}
          onVoted={onChanged}
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
  token,
  view,
  isCreator,
  onRevised,
}: {
  token: string
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
        token={token}
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
              ? 'Results are revealed once you close the poll'
              : "Results are revealed once the poll's creator closes it"}
            {scores && ', and you can change your vote until then'}
          </Text>
          {scores && (
            <Button variant="light" onClick={() => setRevising(true)}>
              Change my vote
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
    <Stack gap="sm">
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
  token,
  options,
  needsName,
  initial,
  onVoted,
  onCancel,
}: {
  token: string
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
  const [name, setName] = useState('')
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
    const scores = options.map((o) => ({ candidate_id: o.id, score: values[o.id] ?? 0 }))
    const { error: rpcError } = revising
      ? await supabase.rpc('open_poll_revise', {
          p_token: token,
          p_scores: scores,
          p_voter_key: voterKeyFor(token),
        })
      : await supabase.rpc('open_poll_submit', {
          p_token: token,
          p_scores: scores,
          p_voter_key: voterKeyFor(token),
          p_voter_name: needsName ? trimmedName : null,
        })
    setSubmitting(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
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

      {options.map((option) => (
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
