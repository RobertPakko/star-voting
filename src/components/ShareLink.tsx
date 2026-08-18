import { Button, CopyButton, Group, Stack, Text, TextInput } from '@mantine/core'
import type { Poll } from '../lib/types'
import { shareLinkFor } from '../lib/shareLink'
import { ShareQr } from './ShareQr'

/**
 * The link to hand around. Both modes get one; what the link grants differs
 * sharply, so the caption spells it out rather than leaving the creator to
 * assume.
 *
 * Copy is the common case and stays a click away. The QR code sits beside it
 * for the case copying can't reach — a room of people with phones, a poll
 * put on a projector or a printed sheet — and opens in a modal rather than
 * taking up the block, since a code small enough to inline is too small to
 * scan.
 *
 * Renders bare, with no card of its own: it sits inside the creator's manage
 * block and inside the open-poll thank-you card, both of which already have
 * a surface.
 */
export function ShareLink({
  poll,
}: {
  poll: Pick<Poll, 'id' | 'title' | 'mode' | 'public_token'>
}) {
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
        <ShareQr url={url} title={poll.title} isOpen={isOpen} />
      </Group>
      <Text size="xs" c="dimmed">
        {isOpen
          ? 'Anyone with this link can vote, without signing in. Only share it with the people you want voting.'
          : 'Only invited people can vote. Anyone else who opens this will be asked to sign in and then told the poll is unavailable.'}
      </Text>
    </Stack>
  )
}
