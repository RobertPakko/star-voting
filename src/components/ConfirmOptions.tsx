import { useState } from 'react'
import { Badge, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { openPollRpc } from '../lib/samplePoll'
import { VOTER_NAME_MAX } from '../lib/limits'
import { voterKeyFor } from '../lib/voterKey'
import { rememberVoterName, rememberedVoterName } from '../lib/voterName'
import { badgeColor } from '../lib/badgeColors'

/**
 * Which endpoint a confirmation goes through: the same split as
 * `OptionsSource`, for the same reason. A session proves who is confirming on
 * an invite poll; behind a share link there is no session, so the browser's
 * per-poll key stands in for one and a typed name is what the roster shows.
 */
export type ConfirmSource = { kind: 'poll'; pollId: string } | { kind: 'open'; pollId: string }

/**
 * "I have had my say" — the button that ends one person's part in the
 * option-collecting stage, and the count of how many have pressed it.
 *
 * The stage used to report one number, how many options were in, which says
 * nothing about how many people put them there: seven options is seven people
 * with one idea each or one person with seven, and neither is distinguishable
 * from a poll nobody has opened. This is the missing half.
 *
 * **It says the person is done, not that they approve the list.** That is
 * deliberately the weaker of the two readings and it is what keeps the signal
 * stable: a suggestion arriving after somebody confirms does not un-confirm
 * them, so one late idea cannot keep a poll collecting for ever. What every
 * voter is promised is that they score the same list, and that promise is kept
 * by the moment the list is finalized rather than by this.
 *
 * **It can be taken back, for as long as it can be given.** Confirming is one
 * click that can open a poll for everybody, and the honest counterpart of a
 * button that does something irreversible is one that undoes it while it still
 * means anything. Once the poll opens there is nothing left to be done adding
 * to, and the database refuses; so does this, by not being on screen.
 *
 * **A share link asks for a name, because it has nothing else to go on.** An
 * invite poll knows who is confirming from the session, and its roster is the
 * invite list. Behind a link there is no account, so a bare count would answer
 * "how many" when the question is "who". A poll that hides its respondents is
 * the exception and keeps its promise: no field, no name, and a count.
 */
export function ConfirmOptions({
  source,
  confirmed,
  confirmedName,
  needsName,
  progress,
  onChanged,
}: {
  source: ConfirmSource
  /** Whether this reader has already confirmed; the button draws either way. */
  confirmed: boolean
  /** The name they confirmed under, on an open poll that names them. */
  confirmedName?: string | null
  /**
   * Whether a name has to be typed before confirming: an open poll that shows
   * its respondents, and nothing else. `open_poll_confirm_options` applies
   * exactly this rule, and discards a name on a poll that hides them.
   */
  needsName?: boolean
  /**
   * How many have confirmed, and out of how many where there is a list of
   * people to be out of. Left off entirely rather than passed as zero where
   * the poll has nobody to count towards.
   */
  progress?: { confirmed: number; of?: number }
  /** A confirmation went in or came back off: re-read the poll. */
  onChanged: () => void
}) {
  // Offered rather than imposed, exactly as on the ballot: the name this
  // browser last voted or confirmed under, editable like any other. See
  // lib/voterName.ts for why the browser is the one place entitled to carry
  // it from one question to the next.
  const [name, setName] = useState(rememberedVoterName)
  const [busy, setBusy] = useState(false)
  // Wrong with the name being typed, marked on the box it was typed in;
  // `error` is a request that failed, which is about the poll rather than
  // about the field.
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (busy) return
    setError(null)
    setNameError(null)

    const trimmed = name.trim()
    if (needsName && !trimmed) {
      setNameError('Enter your name so the group can see who has confirmed.')
      return
    }

    setBusy(true)
    const { error: rpcError } =
      source.kind === 'poll'
        ? await supabase.rpc('confirm_options', { p_poll_id: source.pollId })
        : await openPollRpc('open_poll_confirm_options', {
            p_poll_id: source.pollId,
            p_voter_key: voterKeyFor(source.pollId),
            p_voter_name: needsName ? trimmed : null,
          })
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    // Remembered only once a confirmation has actually gone in under it, so a
    // name the server refused is not offered back on the next poll.
    if (needsName) rememberVoterName(trimmed)
    notifications.show({ message: 'Options confirmed', color: 'green' })
    onChanged()
  }

  async function undo() {
    if (busy) return
    setError(null)
    setBusy(true)
    const { error: rpcError } =
      source.kind === 'poll'
        ? await supabase.rpc('unconfirm_options', { p_poll_id: source.pollId })
        : await openPollRpc('open_poll_unconfirm_options', {
            p_poll_id: source.pollId,
            p_voter_key: voterKeyFor(source.pollId),
          })
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    notifications.show({ message: 'Confirmation withdrawn', color: 'green' })
    onChanged()
  }

  return (
    <Stack gap="xs">
      {confirmed ? (
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Text size="sm" style={{ flex: 1, minWidth: 200 }}>
            <Badge variant="light" color={badgeColor.done} mr="xs">
              Confirmed
            </Badge>
            {confirmedName
              ? `You confirmed these options as ${confirmedName}.`
              : 'You have confirmed these options.'}
          </Text>
          <Button variant="subtle" onClick={undo} loading={busy}>
            Undo
          </Button>
        </Group>
      ) : (
        <Group justify="space-between" wrap="wrap" gap="sm" align="flex-start">
          <Stack gap={4} style={{ flex: 1, minWidth: 200 }}>
            <Text size="sm" c="dimmed">
              Confirm the options once you have nothing more to add.
            </Text>
            {needsName && (
              <TextInput
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
                /* The field stands alone rather than in a form, so Enter has
                   nothing to submit unless it is given something. */
                enterKeyHint="done"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  confirm()
                }}
              />
            )}
          </Stack>
          <Button onClick={confirm} loading={busy}>
            Confirm options
          </Button>
        </Group>
      )}

      {progress && (
        <Text size="xs" c="dimmed">
          {progressLine(progress)}
        </Text>
      )}

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
    </Stack>
  )
}

/**
 * How far the stage has got, in the one sentence that says it.
 *
 * Three shapes, and the differences between them are all about what the count
 * is counting towards. An invite poll has a list of people, so it has a
 * denominator and a consequence worth stating: reaching it is what opens the
 * poll, and somebody deciding whether to press the button should know that
 * before they press it. An open poll has neither — anyone holding the link can
 * confirm and no number of them ends the stage — so it reports the count and
 * stops.
 *
 * **A full house promises nothing**, which is the third shape and the one that
 * is easy to get wrong. Everyone confirming usually opens the poll, and then
 * this line is gone with the stage it described. Reaching it means the poll
 * stayed put, for one of two reasons this component cannot tell apart: a
 * question of the group that somebody has not confirmed yet, or a list that
 * still has fewer than two options on it. Repeating "as soon as everyone has
 * confirmed" there would be promising an opening that has already not
 * happened.
 *
 * Not exported, and written here rather than at the call sites, for the reason
 * `turnoutLabel` is: one wording, in one place, so two screens counting the
 * same thing cannot come to describe it differently.
 */
function progressLine({ confirmed, of }: { confirmed: number; of?: number }): string {
  if (of === undefined) {
    return `${confirmed} ${confirmed === 1 ? 'person has' : 'people have'} confirmed these options.`
  }
  if (confirmed >= of) {
    return 'Everyone has confirmed these options.'
  }
  return (
    `${confirmed} of ${of} ${of === 1 ? 'person has' : 'people have'} confirmed these options. ` +
    'The poll opens for voting as soon as everyone has.'
  )
}

/**
 * Who is done adding options, on an open poll that names its respondents.
 *
 * The invite side has no component of its own: its roster *is* the invite
 * list, so `Respondents` says it there, on the card it already draws, with the
 * badge answering "confirmed?" instead of "voted?" while the poll is still
 * collecting. Behind a share link there is no list to annotate — the names
 * exist only because people typed them — so there is a card.
 *
 * No embargo, unlike the voter roster it sits in place of. What that embargo
 * protects is the order ballots arrived in; a poll still collecting its
 * options has no ballots to attach an order to, and knowing who has finished
 * is the entire point of the thing.
 */
export function Confirmations({ names }: { names: string[] }) {
  return (
    <Stack gap="xs">
      <Title order={4}>Confirmed the options</Title>
      <Card withBorder>
        {names.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nobody has confirmed the options yet.
          </Text>
        ) : (
          <Group gap="xs">
            {names.map((confirmedBy) => (
              <Badge key={confirmedBy} variant="light" color={badgeColor.done}>
                {confirmedBy}
              </Badge>
            ))}
          </Group>
        )}
      </Card>
    </Stack>
  )
}
