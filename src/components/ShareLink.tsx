import { useId } from 'react'
import { Button, CopyButton, Group, Input } from '@mantine/core'
import type { Poll } from '../lib/types'
import { shareLinkFor } from '../lib/shareLink'
import { ShareQr } from './ShareQr'

/**
 * The link to hand around. Both modes get one; what the link grants differs
 * sharply, so the caption spells it out rather than leaving the creator to
 * assume.
 *
 * **The label and the caption span the whole row**, above all three controls
 * rather than above the box alone. As the `TextInput`'s own label they sat
 * inside a field sharing a no-wrap row with two buttons, and on a narrow
 * screen the sentence unspooled down a column a few words wide. Nothing about
 * the caption was only about the box either: *Anyone with this link can vote
 * without signing in* is as true of what Copy lifts and what the QR code
 * carries. So the wrapper holds the row, `htmlFor` still names the box for a
 * screen reader, and the sentence gets its full width.
 *
 * Renders bare, with no card of its own: it sits inside surfaces that already
 * have one.
 */
export function ShareLink({ poll }: { poll: Pick<Poll, 'id' | 'title' | 'mode' | 'closed_at'> }) {
  const url = shareLinkFor(poll)
  const isOpen = poll.mode === 'open'
  // The label sits outside the field now, so the two need an id between them
  // for `htmlFor` to reach across the row. Generated rather than fixed: this
  // renders on the creator's page and inside the open-poll panel, and a
  // hand-written id would be a duplicate the day both appear at once.
  const fieldId = useId()

  return (
    <Input.Wrapper
      id={fieldId}
      label="Share this poll"
      description={
        poll.closed_at
          ? isOpen
            ? 'Anyone with this link can view the results'
            : 'Only invited people can view the results; they must sign in to do so'
          : isOpen
            ? 'Anyone with this link can vote without signing in'
            : 'Only invited people can vote; they must sign in to do so'
      }
    >
      {/* Centred rather than bottom-aligned: with the label lifted out there
          is nothing above the box for the buttons to hang level with. */}
      <Group gap="xs" wrap="nowrap" align="center">
        <Input
          id={fieldId}
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
        <ShareQr url={url} title={poll.title} />
      </Group>
    </Input.Wrapper>
  )
}
