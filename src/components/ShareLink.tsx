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
 * **The label and the caption span the whole row, above all three controls
 * rather than above the box alone.** They were the `TextInput`'s own label
 * once, which put them inside a field sharing a no-wrap row with two
 * buttons: the caption is a full sentence and the field is the part that
 * gives, so on a narrow screen it was squeezed into a column a few words
 * wide and the sentence unspooled down it. Nothing about the caption was
 * ever only about the box, either — *Anyone with this link can vote without
 * signing in* is as true of the link the Copy button lifts and of the one
 * the QR code carries, and all three are one control for handing the poll
 * out. So the wrapper holds the row, the label still names the box for a
 * screen reader through `htmlFor`, and the sentence gets the full width it
 * is written for.
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
        <ShareQr url={url} title={poll.title} isOpen={isOpen} />
      </Group>
    </Input.Wrapper>
  )
}
