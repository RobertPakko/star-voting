import { Group, Text } from '@mantine/core'
import classes from './LiveIndicator.module.css'

/**
 * The "this page is updating itself" dot: a solid point with a second one
 * pulsing out from under it, beside the word Live.
 *
 * It exists because the alternative is invisible. A page that quietly
 * refreshes itself looks exactly like a page that has gone stale, so a
 * reader who is waiting on a vote reloads anyway — and one who isn't
 * assumes the count in front of them is current when it might not be. The
 * dot is what makes the difference readable, which is also why the paused
 * state is shown rather than hidden: a backgrounded tab stops polling, and
 * that is worth saying out loud.
 *
 * The live dot takes the theme's primary colour rather than a key from
 * `badgeColors.ts`. That file exists so that badges sitting side by side
 * never share a colour for two different meanings, and this is not a badge:
 * it reports the state of the page rather than a fact about the poll, and
 * it is the only thing on screen that moves. Green in particular is spoken
 * for — it means *settled* on every badge in the app, which is the opposite
 * of what a live poll is.
 */
export function LiveIndicator({ paused = false }: { paused?: boolean }) {
  return (
    <Group gap={6} wrap="nowrap" role="status">
      <span className={classes.indicator} aria-hidden>
        {paused ? (
          <span className={classes.paused} />
        ) : (
          <>
            <span className={classes.dot} />
            <span className={classes.pulse} />
          </>
        )}
      </span>
      <Text size="xs" c="dimmed">
        {paused ? 'Paused' : 'Live'}
      </Text>
    </Group>
  )
}
