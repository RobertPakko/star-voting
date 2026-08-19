import { useRef, useState } from 'react'
import { Badge, Button, Card, Group, Rating, Stack, Text, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { voterKeyFor } from '../lib/voterKey'
import { badgeColor, countBadge } from '../lib/badgeColors'
import { Ballots } from './Ballots'
import { CollectOptions } from './CollectOptions'
import { OptionDescription } from './OptionDescription'
import { Results } from './Results'
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
 * it -- they render the poll's title and tags around this panel -- and both
 * now re-read it on a timer to keep votes arriving without a reload, so
 * fetching it here as well would mean two copies of the same poll on one
 * screen, refreshed on two clocks, free to disagree about whether it has
 * closed. The page owns the poll; this renders it and reports a vote back.
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
        pollId={view.poll.id}
        options={view.options}
        isCreator={isCreator}
        onChanged={onChanged}
      />
    )
  }

  // Who took part, in the one shape this poll can say it: the roster when it
  // names respondents, a bare count when it doesn't. Rendered under whatever
  // stage the poll is in, so turnout is reported once on every screen and in
  // the same place -- the results above it no longer state it themselves.
  //
  // Held back until you have voted, because nothing in it helps you fill in a
  // ballot and on a poll that names respondents it is a live feed of the
  // arrival order -- which the app otherwise works to keep off the published
  // ballots (see the ordering note in AGENTS.md). Withholding it until you
  // vote leaves that order visible only to people actually in the poll rather
  // than to anyone holding the link.
  //
  // Two exemptions. The creator, because the roster is what "close voting
  // now" gets decided on and a creator who isn't voting could never earn the
  // view. And a poll whose results are out, because the reason for the
  // embargo is that a ballot might still be cast, and on that poll none can.
  const participation =
    view.voted || isCreator || view.results_available ? (
      view.voters ? (
        <VoterList voters={view.voters} />
      ) : (
        <Card withBorder>
          <Group justify="space-between" gap="xs">
            <Text size="sm" c="dimmed">
              This poll doesn't show who has responded.
            </Text>
            <ResponseCount count={view.voted_count} />
          </Group>
        </Card>
      )
    ) : null

  if (view.results_available) {
    return (
      <Stack gap="lg">
        <Results source={{ kind: 'token', token }} />
        {/* Gated in the database on the same terms as the results, so this
            condition only decides whether to ask. */}
        {view.poll.show_ballots && <Ballots source={{ kind: 'token', token }} />}
        {participation}
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
        <Card withBorder>
          <Stack gap="xs">
            <Text fw={500}>Your vote is in</Text>
            <Text size="sm" c="dimmed">
              {isCreator
                ? 'Results are revealed once you close the poll'
                : "Results are revealed once the poll's creator closes it"}
            </Text>
          </Stack>
        </Card>
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

function ResponseCount({ count }: { count: number }) {
  return (
    <Badge {...countBadge}>
      {count} {count === 1 ? 'response' : 'responses'}
    </Badge>
  )
}

function VoterList({ voters }: { voters: string[] }) {
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Group justify="space-between" gap="xs">
          <Text fw={500} size="sm">
            Voted so far
          </Text>
          <ResponseCount count={voters.length} />
        </Group>
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
      </Stack>
    </Card>
  )
}

function OpenBallot({
  token,
  options,
  needsName,
  onVoted,
}: {
  token: string
  options: PollOption[]
  needsName: boolean
  showBallots: boolean
  onVoted: () => void
}) {
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  /**
   * Dismissing the on-screen keyboard on a phone does not blur the field it
   * belongs to, and Rating cancels the default action of the tap that picks a
   * star, so focus never moves off the name box on its own. Left alone, every
   * score a voter gives pops the keyboard back up over the ballot. Dropping
   * focus as the tap starts -- before the browser decides whether to re-open
   * the keyboard -- leaves the stars tappable in peace.
   *
   * The same blur is what Enter needs: the name field stands alone rather than
   * in a form, so there is nothing for Enter to submit and the keyboard simply
   * stays up. See the key handler on the field.
   */
  function releaseNameFocus() {
    nameRef.current?.blur()
  }

  async function handleSubmit() {
    setError(null)

    const trimmedName = name.trim()
    if (needsName && !trimmedName) {
      setError('Enter your name so the group can see who has voted.')
      return
    }

    setSubmitting(true)
    const { error: rpcError } = await supabase.rpc('open_poll_submit', {
      p_token: token,
      p_scores: options.map((o) => ({ candidate_id: o.id, score: values[o.id] ?? 0 })),
      p_voter_key: voterKeyFor(token),
      p_voter_name: needsName ? trimmedName : null,
    })
    setSubmitting(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    notifications.show({ message: 'Vote submitted', color: 'green' })
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
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={60}
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
            {/* See the note on the invite-poll ballot: without allowClear a
                score of 0 is unreachable once any star is picked. */}
            <Rating
              count={5}
              allowClear
              value={values[option.id] ?? 0}
              onChange={(v) => setValues((prev) => ({ ...prev, [option.id]: v }))}
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
        <Button onClick={handleSubmit} loading={submitting}>
          Submit vote
        </Button>
      </Group>
    </Stack>
  )
}
