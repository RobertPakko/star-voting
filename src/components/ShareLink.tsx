import { useEffect, useId, useState } from 'react'
import { Button, Group, Input } from '@mantine/core'
import { CheckIcon, CopyIcon, ShareNetworkIcon } from '@phosphor-icons/react'
import type { Poll } from '../lib/types'
import { shareLinkFor } from '../lib/shareLink'
import { canShareNatively, shareLink, shareSentence, type ShareStage } from '../lib/share'
import { announce } from '../lib/announce'
import { ShareQr } from './ShareQr'
import classes from './ShareLink.module.css'

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
 * without signing in* is as true of what Share sends and what the QR code
 * carries. So the wrapper holds the row, `htmlFor` still names the box for a
 * screen reader, and the sentence gets its full width.
 *
 * Renders bare, with no card of its own: it sits inside surfaces that already
 * have one.
 */
export function ShareLink({
  poll,
  stage,
}: {
  poll: Pick<Poll, 'id' | 'title' | 'mode' | 'closed_at'>
  /** Where the poll has got to, which is what the shared message asks for. */
  stage: ShareStage
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
        <ShareButton title={poll.title} text={shareSentence(poll.title, stage)} url={url} />
        <ShareQr url={url} title={poll.title} />
      </Group>
    </Input.Wrapper>
  )
}

/**
 * Share where the device has a share sheet, Copy where it does not — named
 * for what it will do, since a *Share* that silently copies is a button that
 * did something other than it said.
 *
 * A copy still has no evidence of itself but this button, so it keeps the tick
 * and the green the old Copy button had (ShareLink.module.css), and tells a
 * screen reader as well. A share needs neither: the sheet is the receipt.
 */
function ShareButton({ title, text, url }: { title: string; text: string; url: string }) {
  const native = canShareNatively()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied])

  async function press() {
    const outcome = await shareLink({ title, text, url })
    if (outcome === 'copied') {
      setCopied(true)
      announce('Link copied')
    }
  }

  const Glyph = native ? ShareNetworkIcon : CopyIcon
  return (
    <Button
      variant="light"
      color={copied ? 'green' : undefined}
      onClick={() => void press()}
      className={classes.copy}
      leftSection={
        copied ? (
          <span className={classes.tick}>
            <CheckIcon size={16} weight="bold" aria-hidden />
          </span>
        ) : (
          <Glyph size={16} aria-hidden />
        )
      }
    >
      {/* Keyed on the word, so each one is drawn rather than the letters
          being rewritten in place. */}
      <span key={copied ? 'copied' : 'idle'} className={classes.label}>
        {copied ? 'Copied' : native ? 'Share' : 'Copy'}
      </span>
    </Button>
  )
}
