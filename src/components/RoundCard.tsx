import { useId, useRef, useState, type ReactNode } from 'react'
import { Button, Card, Group, Stack, Title } from '@mantine/core'
import { ScalesIcon } from '@phosphor-icons/react'
import classes from './RoundCard.module.css'

/**
 * One round of the tally — Scoring or Runoff — under its heading, with the
 * tie-break that round needed folded away behind it.
 *
 * A tie-break is the working behind a result rather than the result: it says
 * *why* these two reached the runoff, or *why* the runoff went the way a level
 * vote could not decide. It used to be a card of its own between the rounds,
 * always open, and on a poll with a wide tie — a schedule poll's windows tie
 * at the top all the time — it was the longest thing on the page, in the way
 * of the runoff everybody had come to read. So it now belongs to the round it
 * settled, closed until asked for, and is opened by a button over that round's
 * card.
 *
 * **It slides across the card rather than opening under it.** The tie-break is
 * a second reading of the same round, not more of the page, and putting it in
 * the round's own place says so: the scores go away while you read how a tie
 * among them was broken, and come back when you are done.
 *
 * **The card never changes height.** It stays the height of the round, and a
 * tie-break taller than that scrolls inside the panel. Letting the card grow
 * to fit pushed everything below it down the page at the moment the reader
 * pressed a button about one card, and shrinking it back moved it all up
 * again.
 *
 * The side that is not showing is `inert`, so it is out of the tab order and
 * hidden from screen readers. Otherwise a keyboard could tab into a panel
 * that is off the card, and a screen reader would read both sides at once.
 */
export function RoundCard({
  title,
  tieBreak,
  tieBreakLabel = 'tie-break',
  children,
}: {
  title: string
  /** What settled this round's tie. No tie, no button. */
  tieBreak?: ReactNode
  /** The button's noun, for the round that needed more than one. */
  tieBreakLabel?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const panel = useRef<HTMLDivElement>(null)

  const toggle = () => {
    // A long tie-break scrolls inside the panel, and opening it again should
    // start from its first line rather than wherever the last reading stopped.
    if (!open && panel.current) panel.current.scrollTop = 0
    setOpen(!open)
  }

  return (
    <Stack gap={2}>
      <Group justify="space-between" align="flex-end" wrap="nowrap" gap="xs">
        <Title order={4}>{title}</Title>
        {tieBreak && (
          <Button
            variant="subtle"
            size="compact-sm"
            leftSection={<ScalesIcon size={16} aria-hidden />}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={toggle}
          >
            {open ? `Hide ${tieBreakLabel}` : `Show ${tieBreakLabel}`}
          </Button>
        )}
      </Group>
      <Card withBorder p={0}>
        <div className={classes.slider}>
          <div inert={open}>
            <div className={classes.side}>{children}</div>
          </div>
          {tieBreak && (
            <div
              ref={panel}
              id={panelId}
              className={classes.back}
              data-open={open || undefined}
              inert={!open}
            >
              <div className={classes.side}>{tieBreak}</div>
            </div>
          )}
        </div>
      </Card>
    </Stack>
  )
}
