import { Button, CopyButton, Group, Stack, Text, TextInput } from '@mantine/core'
import type { Poll } from '../lib/types'
import { shareLinkFor } from '../lib/shareLink'
import { ShareQr } from './ShareQr'

/**
 * The link to hand around. Both modes get one; what the link grants differs
 * sharply, so the caption spells it out rather than leaving the creator to
 * assume.
 *
 * Renders bare, with no card of its own: it sits inside the creator's manage
 * block and inside the open-poll thank-you card, both of which already have
 * a surface.
 */
export function ShareLink({
  poll,
}: {
  poll: Pick<Poll, 'id' | 'title' | 'mode' | 'public_token' | 'closed_at'>
}) {
  const url = shareLinkFor(poll)
  const isOpen = poll.mode === 'open'

  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="nowrap" align="flex-end">
        <TextInput
          label="Share this poll"
          description={poll.closed_at
          ? isOpen
            ? 'Anyone with this link can view the results'
            : 'Only invited people can view the results; they must sign in to do so'
          : isOpen
          ? 'Anyone with this link can vote without signing in'
          : 'Only invited people can vote; they must sign in to do so'}
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
    </Stack>
  )
}
