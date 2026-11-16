import { Button, Group, Modal, ScrollArea, Stack, Text, TextInput } from '@mantine/core'
import { EnvelopeSimpleIcon, IdentificationBadgeIcon } from '@phosphor-icons/react'
import { VOTER_NAME_MAX } from '../lib/limits'

/**
 * Asked on *Create poll* of an invite poll that shows its voters: show them
 * by address, or give everybody a name.
 *
 * A roster of addresses hands every voter's address to every other voter,
 * and leaves anybody who does not know them all guessing which is whose. So
 * the creator may name everybody instead, and then only the creator sees
 * the addresses (`poll_invitees`). **All or none**: a roster with some names
 * and some addresses shows the addresses of exactly the people it was meant
 * to keep them for, so *Use names* waits until every box is filled. Two
 * people cannot share a name, since the roster could not say which of them
 * has voted. The database holds both rules (`apply_invitee_names`).
 *
 * The names are kept by the form, so going back to change the list keeps
 * what was typed.
 */
export function VoterNamesModal({
  opened,
  emails,
  names,
  onNamesChange,
  onUseEmails,
  onUseNames,
  onClose,
  submitting,
}: {
  opened: boolean
  /** Everybody invited, the creator included where they invited themselves. */
  emails: string[]
  /** Address to name, as typed. */
  names: Record<string, string>
  onNamesChange: (names: Record<string, string>) => void
  onUseEmails: () => void
  onUseNames: () => void
  onClose: () => void
  submitting: boolean
}) {
  const clashes = clashingNames(emails, names)
  const complete = emails.length > 0 && emails.every((email) => names[email]?.trim())

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={<Text fw={600}>Assign names to voters?</Text>}
      centered
    >
      <Stack gap="md">
        <Text size="sm">
          You can assign names to voters if you want to show the voters without using emails.
        </Text>
        <ScrollArea.Autosize mah="50vh" type="auto" offsetScrollbars>
          <Stack gap="xs">
            {emails.map((email) => (
              <TextInput
                key={email}
                label={email}
                placeholder="Name"
                value={names[email] ?? ''}
                maxLength={VOTER_NAME_MAX}
                error={clashes.has(email) ? 'Somebody else already has this name.' : undefined}
                onChange={(e) => onNamesChange({ ...names, [email]: e.currentTarget.value })}
                styles={{ label: { fontWeight: 400, wordBreak: 'break-all' } }}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <Group justify="flex-end">
          <Button
            variant="default"
            onClick={onUseEmails}
            disabled={submitting}
            leftSection={<EnvelopeSimpleIcon size={16} aria-hidden />}
          >
            Use emails
          </Button>
          <Button
            onClick={onUseNames}
            disabled={!complete || clashes.size > 0}
            loading={submitting}
            leftSection={<IdentificationBadgeIcon size={16} aria-hidden />}
          >
            Use names
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** The addresses whose name an earlier address already has, ignoring case. */
function clashingNames(emails: string[], names: Record<string, string>): Set<string> {
  const seen = new Set<string>()
  const clashing = new Set<string>()
  for (const email of emails) {
    const name = names[email]?.trim().toLowerCase()
    if (!name) continue
    if (seen.has(name)) clashing.add(email)
    seen.add(name)
  }
  return clashing
}
