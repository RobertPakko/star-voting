import { Button, CopyButton, Group, Stack, Text, TextInput } from '@mantine/core'
import type { Poll } from '../lib/types'
import { shareLinkFor } from '../lib/shareLink'

/**
 * The link to hand around. Both modes get one; what the link grants differs
 * sharply, so the caption spells it out rather than leaving the creator to
 * assume.
 *
 * Renders bare, with no card of its own: it sits inside the creator's manage
 * block and inside the open-poll thank-you card, both of which already have
 * a surface.
 */
export function ShareLink({ poll }: { poll: Pick<Poll, 'id' | 'mode' | 'public_token'> }) {
  const url = shareLinkFor(poll)
  const isOpen = poll.mode === 'open'

  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">
        Share this poll
      </Text>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          value={url}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: 1 }}
        />
        <CopyButton value={url}>
          {({ copied, copy }) => (
            <Button variant="light" color={copied ? 'green' : undefined} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Text size="xs" c="dimmed">
        {isOpen
          ? 'Anyone with this link can vote, without signing in. Only share it with the people you want voting.'
          : 'Only invited people can vote. Anyone else who opens this will be asked to sign in and then told the poll is unavailable.'}
      </Text>
    </Stack>
  )
}
