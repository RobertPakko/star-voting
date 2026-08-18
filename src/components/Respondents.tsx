import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionIcon, Badge, Button, Card, Group, Stack, Text, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { badgeColor, countBadge } from '../lib/badgeColors'
import type { Invitee, PollStatus } from '../lib/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The invite list for an invite-mode poll.
 *
 * Who sees it is decided in the database (poll_invitees): every participant
 * when the poll shows respondents, the creator alone otherwise — and in
 * that case has_voted comes back null, so the creator keeps the address
 * list they need to manage invites without the roster of who has voted.
 *
 * The add/remove controls are creator-only and unchanged in behaviour.
 */
export function Respondents({
  pollId,
  isCreator,
  status,
  liveTick = 0,
  onChange,
}: {
  pollId: string
  isCreator: boolean
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
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('poll_invitees', { p_poll_id: pollId })
    if (rpcError) {
      // A refresh that fails leaves the roster already on screen alone --
      // only a first read tells us anything about access, and a dropped
      // request should not make a list that has been there all along
      // vanish or sprout an error.
      if (loaded.current) return
      // For a non-creator the expected failure is "this poll doesn't show
      // who responded", which just means there is nothing to render. The
      // creator always has access, so for them a failure is real and
      // hiding their invite controls silently would be worse than noise.
      if (isCreator) setError(rpcError.message)
      else setHidden(true)
      return
    }
    loaded.current = true
    setInvitees((data as Invitee[]) ?? [])
  }, [pollId, isCreator])

  useEffect(() => {
    load()
  }, [load, liveTick])

  async function addInvitee() {
    const email = newEmail.trim().toLowerCase()
    setError(null)
    if (!EMAIL_RE.test(email)) {
      setError('Enter a valid email address.')
      return
    }
    if (invitees?.some((i) => i.email === email)) {
      setError('That person is already invited.')
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

  if (hidden) return null

  if (!invitees) {
    return error ? (
      <Text c="red" size="sm">
        {error}
      </Text>
    ) : null
  }

  const showsStatus = invitees.some((i) => i.has_voted !== null)

  return (
    <Card withBorder>
      <Stack gap="xs">
        <Group justify="space-between" gap="xs">
          <Text fw={500} size="sm">
            Invited voters
          </Text>
          <Badge {...countBadge}>
            {status.voted_count}/{status.invited_count} voted
          </Badge>
        </Group>

        {invitees.map((invitee) => (
          <Group key={invitee.email} justify="space-between" wrap="nowrap" gap="xs">
            <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
              {invitee.email}
            </Text>
            <Group gap="xs" wrap="nowrap">
              {invitee.has_voted !== null && (
                <Badge
                  size="sm"
                  variant="light"
                  color={invitee.has_voted ? badgeColor.done : badgeColor.outstanding}
                >
                  {invitee.has_voted ? 'Voted' : 'Pending'}
                </Badge>
              )}
              {isCreator && (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Remove ${invitee.email}`}
                  // Someone who already voted can't be removed -- their
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
        ))}

        {!showsStatus && (
          <Text size="xs" c="dimmed">
            This poll hides who has responded, so only the number of votes is shown.
          </Text>
        )}

        {/* Once results are out, adding a voter would let them vote knowing
            the standings, so the database blocks it -- don't offer the field. */}
        {isCreator && !status.is_closed && !status.results_available && (
          <Group gap="xs" wrap="nowrap" mt={4}>
            <TextInput
              placeholder="Invite another voter"
              value={newEmail}
              onChange={(e) => setNewEmail(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && addInvitee()}
              style={{ flex: 1 }}
            />
            <Button variant="light" onClick={addInvitee} loading={busy}>
              Add
            </Button>
          </Group>
        )}

        {isCreator && status.results_available && !status.is_closed && (
          <Text size="xs" c="dimmed">
            The results are out, so no one else can be invited — a late voter would be voting with
            the standings already known. Start a new poll to include more people.
          </Text>
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
