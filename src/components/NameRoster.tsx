import { Badge, Card, Group, Stack, Text, Title, VisuallyHidden } from '@mantine/core'
import { badgeColor, outlineInk } from '../lib/badgeColors'
import { useArrivalOrder, useArrivals } from '../lib/useArrivals'
import arrival from './badgeArrival.module.css'

/**
 * The names themselves, for the two rosters that are nothing but names: no
 * controls, and a line saying so while there are none.
 *
 * A name that joins while the card is on screen pops in and glows
 * (`badgeArrival.module.css`), so the reader can see who has just answered
 * without comparing the list to the one they last looked at. It joins at the
 * end, rather than at its place in the alphabet the database sorts by, so it
 * lands where a reader looks for something new and moves nobody else.
 *
 * **`pending` is who the poll expects and has not heard from**: on a
 * sequential open poll, the earlier voters no ballot has claimed yet. They
 * are drawn after the answered names as outlines, as `Respondents` draws an
 * invitee still owed (*Did not vote* in the closed colour once the poll is
 * closed), so a voter who typed a near miss of their own name sees it still
 * waiting and can correct their ballot's name to claim it.
 */
export function NameRoster({
  title,
  names,
  pending = [],
  closed = false,
  empty,
}: {
  title: string
  names: string[]
  pending?: string[]
  /** Whether the poll has stopped taking answers, which turns *Pending* into *Did not vote*. */
  closed?: boolean
  /** What the card says while nobody is in it. */
  empty: string
}) {
  const shown = useArrivalOrder(names)
  const arriving = useArrivals(shown)
  const owed = closed
    ? { label: 'Did not vote', color: badgeColor.closed }
    : { label: 'Pending', color: badgeColor.outstanding }

  return (
    // Out of the page's SmoothHeight: a name joining is not a card being
    // swapped. When it lands in the same read as an option joining the list
    // above, the page measured its new height with that row still at nothing
    // and clipped this roster out of sight until its animation ran out.
    <Stack gap={2} data-own-height>
      <Title order={2} size="h4">
        {title}
      </Title>
      <Card withBorder>
        {shown.length === 0 && pending.length === 0 ? (
          <Text size="sm" c="dimmed">
            {empty}
          </Text>
        ) : (
          <Group gap="xs">
            {shown.map((name) => (
              <Badge
                key={name}
                variant="light"
                color={badgeColor.done}
                className={arriving.has(name) ? arrival.arriving : undefined}
              >
                {name}
                {pending.length > 0 && <VisuallyHidden> (voted)</VisuallyHidden>}
              </Badge>
            ))}
            {pending.map((name) => (
              <Badge
                key={`pending:${name}`}
                variant="outline"
                color={owed.color}
                title={owed.label}
                style={outlineInk(owed.color)}
              >
                {name}
                <VisuallyHidden> ({owed.label.toLowerCase()})</VisuallyHidden>
              </Badge>
            ))}
          </Group>
        )}
      </Card>
    </Stack>
  )
}
