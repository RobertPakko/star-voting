import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionIcon, Badge, Button, Card, Group, Stack, Text, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { badgeColor } from '../lib/badgeColors'
import type { Invitee, PollStatus } from '../lib/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Who has responded to an invite-mode poll, in whichever shape the poll
 * allows: the invite list, or the count on its own.
 *
 * Who sees the list is decided in the database (poll_invitees): every
 * participant when the poll shows respondents, the creator alone otherwise;
 * and in that case has_voted comes back null, so the creator keeps the
 * address list they need to manage invites without the roster of who voted.
 *
 * This card answers *who*, and only that. **How many is not here**: the
 * count badge in the poll's header says it once, on every screen the poll
 * appears on, and a card restating it directly underneath is the same fact
 * arriving twice looking like two.
 *
 * **What "who" means depends on where the poll has got to.** While it is still
 * collecting its options nobody can vote, so a column of *Pending* would be
 * answering a question the poll is not asking; the badge says who is done
 * *adding* instead, which is the only thing moving at that stage and the thing
 * a creator deciding whether to open the poll actually needs. It is the same
 * disclosure either way — a roster — so it is held back on exactly the same
 * terms, by the same setting, through the same column of `poll_invitees`.
 *
 * So a poll that hides its respondents renders no card at all for anyone but
 * its creator; the header has already said how many voted, and the
 * "Respondents hidden" tag beside it has already said why there are no names
 * under it. The creator still gets the list, because for them it is the
 * invite list they manage rather than a roster of who voted.
 *
 * Whether the roster is readable is taken from the poll rather than from a
 * failed request. The page already knows the setting, and asking anyway
 * meant one request per refresh that was expected to fail; with the further
 * problem that a request failing for any *other* reason would have been
 * reported to the reader as "this poll hides who has responded", which might
 * not be true.
 *
 * The add/remove controls are creator-only and unchanged in behaviour.
 */
export function Respondents({
  pollId,
  isCreator,
  showVoters,
  status,
  liveTick = 0,
  onChange,
}: {
  pollId: string
  isCreator: boolean
  /**
   * The poll's own setting. A participant on a poll that hides respondents
   * has no roster to ask for, so this decides whether to ask at all.
   */
  showVoters: boolean
  status: PollStatus
  /**
   * Bumped by the poll page on every live refresh. The roster reloads with
   * it rather than on a timer of its own, so who has voted and the count
   * above it are always read at the same moment.
   */
  liveTick?: number
  onChange: () => void
}) {
  const [invitees, setInvitees] = useState<Invitee[] | null>(null)
  const [hidden, setHidden] = useState(false)
  // Whether a read has ever succeeded, so a live refresh that fails can be
  // told apart from a first read that did. Kept in a ref rather than read
  // from `invitees`, which would put the roster in load()'s dependencies
  // and have every load schedule the next one.
  const loaded = useRef(false)
  const [newEmail, setNewEmail] = useState('')
  const [busy, setBusy] = useState(false)
  // Wrong with the address being typed, marked on the box it was typed in.
  // `error` below is for a request that failed, which is about the poll
  // rather than about the field, and stays where it was.
  const [emailError, setEmailError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Nobody but the creator can read the list on a poll that hides
  // respondents, and the poll says so up front, so the request is not made
  // rather than made and expected to fail.
  const rosterReadable = showVoters || isCreator

  const load = useCallback(async () => {
    if (!rosterReadable) return
    const { data, error: rpcError } = await supabase.rpc('poll_invitees', { p_poll_id: pollId })
    if (rpcError) {
      // A refresh that fails leaves the roster already on screen alone;
      // only a first read tells us anything about access, and a dropped
      // request should not make a list that has been there all along
      // vanish or sprout an error.
      if (loaded.current) return
      // The creator always has access, so a failure for them is real and
      // hiding their invite controls silently would be worse than noise.
      // For anyone else it means there is nothing to render.
      if (isCreator) setError(rpcError.message)
      else setHidden(true)
      return
    }
    loaded.current = true
    setInvitees((data as Invitee[]) ?? [])
  }, [pollId, isCreator, rosterReadable])

  useEffect(() => {
    load()
  }, [load, liveTick])

  async function addInvitee() {
    const email = newEmail.trim().toLowerCase()
    setError(null)
    setEmailError(null)

    if (!email) {
      setEmailError('Type an email address to invite.')
      return
    }
    if (!EMAIL_RE.test(email)) {
      setEmailError(`"${email}" doesn't look like an email address.`)
      return
    }
    // Addresses are stored lowercased (normalize_invited_email), so this
    // catches the same duplicate the unique index would.
    if (invitees?.some((i) => i.email === email)) {
      setEmailError('That person is already invited.')
      return
    }

    setBusy(true)
    const { error: insertError } = await supabase
      .from('invited_voters')
      .insert({ poll_id: pollId, email })
    setBusy(false)

    if (insertError) {
      setError(insertError.message)
      return
    }
    setNewEmail('')
    notifications.show({ message: `Invited ${email}`, color: 'green' })
    await load()
    onChange()
  }

  async function removeInvitee(email: string) {
    setError(null)
    setBusy(true)
    const { error: deleteError } = await supabase
      .from('invited_voters')
      .delete()
      .eq('poll_id', pollId)
      .eq('email', email)
    setBusy(false)

    if (deleteError) {
      setError(deleteError.message)
      return
    }
    notifications.show({ message: `Removed ${email}`, color: 'green' })
    await load()
    onChange()
  }

  // No roster to show, either because the poll hides it or because the read
  // came back saying so. Nothing takes its place: the header's count badge
  // has said how many voted and its "Respondents hidden" tag has said why
  // nobody is named, so a card here would only repeat both.
  if (!rosterReadable || hidden) return null

  if (!invitees) {
    return error ? (
      <Text c="red" size="sm">
        {error}
      </Text>
    ) : null
  }

  // Which question the badges are answering. `soliciting` is the poll's own
  // stage rather than this card's idea of one, so the roster and the list
  // above it can never disagree about whether voting has started.
  const collecting = status.soliciting
  // Whether the poll is telling this reader anything per person at all. Read
  // off whichever column is being drawn: a poll that hides its respondents
  // nulls both, and a database that predates has_confirmed sends it undefined,
  // which is the same "nothing to show" and gets the same line underneath.
  const showsStatus = invitees.some((i) =>
    collecting ? (i.has_confirmed ?? null) !== null : i.has_voted !== null,
  )

  return (
    <Card withBorder>
      <Stack gap="xs">
        {invitees.map((invitee) => {
          // Whether this poll says anything about this person at all: the
          // stage decides which column is being drawn, and a poll that hides
          // its respondents nulls it.
          const said = (collecting ? (invitee.has_confirmed ?? null) : invitee.has_voted) !== null
          const mark = standing(collecting, status.is_closed, invitee)
          return (
            <Group key={invitee.email} justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
                {invitee.email}
              </Text>
              <Group gap="xs" wrap="nowrap">
                {said && (
                  <Badge size="sm" variant="light" color={mark.color}>
                    {mark.label}
                  </Badge>
                )}
                {isCreator && (
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Remove ${invitee.email}`}
                    // Someone who already voted can't be removed; their
                    // ballot is counted and can't be honestly un-counted. On a
                    // poll that hides respondents we don't know who that is,
                    // so the database refuses and reports why.
                    disabled={invitee.has_voted === true || status.is_closed || busy}
                    onClick={() => removeInvitee(invitee.email)}
                  >
                    &times;
                  </ActionIcon>
                )}
              </Group>
            </Group>
          )
        })}

        {!showsStatus && (
          <Text size="xs" c="dimmed">
            This poll hides who has responded, so you cannot can see which of these people have{' '}
            {collecting ? 'confirmed the options' : 'voted'}.
          </Text>
        )}

        {/* Once results are out, adding a voter would let them vote knowing
            the standings, so the database blocks it; don't offer the field. */}
        {/* The row is top-aligned so an error message under the box pushes
            the message down rather than the button that dismisses it. */}
        {isCreator && !status.is_closed && !status.results_available && (
          <Group gap="xs" wrap="nowrap" align="flex-start" mt={4}>
            <TextInput
              placeholder="Invite another voter"
              value={newEmail}
              onChange={(e) => {
                setNewEmail(e.currentTarget.value)
                setEmailError(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && addInvitee()}
              error={emailError}
              style={{ flex: 1 }}
            />
            <Button variant="light" onClick={addInvitee} loading={busy}>
              Add
            </Button>
          </Group>
        )}

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
      </Stack>
    </Card>
  )
}

/**
 * What one person's badge says, which is about what they still owe — until
 * the poll stops asking, at which point it is about what they did.
 *
 * *Pending* is a reminder, and a reminder is only honest while there is
 * something to be reminded of. Once the poll is closed the missing ballot is
 * not late, it is never coming: nobody can cast it, the creator cannot chase
 * it, and the roster has turned from a list of who to wait for into a record
 * of what happened. So the badge says the thing that is true — *Did not
 * vote* — in the colour of the poll's own closed state, which is the same
 * fact said one level up.
 *
 * There is no closed reading of the collecting stage, and no need for one: a
 * poll is only soliciting while `closed_at` is null, so the two cannot both
 * be true. See poll_status.
 */
function standing(
  collecting: boolean,
  isClosed: boolean,
  invitee: Invitee,
): { label: string; color: string } {
  if (collecting) {
    return invitee.has_confirmed
      ? { label: 'Confirmed', color: badgeColor.done }
      : { label: 'Pending', color: badgeColor.outstanding }
  }
  if (invitee.has_voted) return { label: 'Voted', color: badgeColor.done }
  return isClosed
    ? { label: 'Did not vote', color: badgeColor.closed }
    : { label: 'Pending', color: badgeColor.outstanding }
}
