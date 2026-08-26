import type { ReactNode } from 'react'
import { Badge, Card, Group, Stack, Text, Title } from '@mantine/core'
import { badgeColor } from '../lib/badgeColors'

/**
 * A heading over a card of people, which is how this app answers *who* every
 * time it is asked.
 *
 * Three cards do it — who has voted on an open poll, who has confirmed the
 * options, and the invite list on `Respondents` — and they are the same
 * answer to the same question about the same poll, sitting one under another
 * on the same page. Three headings that agreed by hand is how they were
 * built and is one edit away from three that do not.
 *
 * **How many is never here.** The count badge in the poll's header says it
 * once, on every screen the poll appears on; a card restating it directly
 * underneath is the same fact arriving twice looking like two.
 */
export function RosterSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Title order={4}>{title}</Title>
      {children}
    </Stack>
  )
}

/**
 * The names themselves, for the two rosters that are nothing but names: no
 * pending column, no controls, and a line saying so while there are none.
 *
 * `Respondents` builds its own card instead, because an invite poll's roster
 * is also the list its creator manages — but it wears the same heading
 * through `RosterSection` above.
 */
export function NameRoster({
  title,
  names,
  empty,
}: {
  title: string
  names: string[]
  /** What the card says while nobody is in it. */
  empty: string
}) {
  return (
    <RosterSection title={title}>
      <Card withBorder>
        {names.length === 0 ? (
          <Text size="sm" c="dimmed">
            {empty}
          </Text>
        ) : (
          <Group gap="xs">
            {names.map((name) => (
              <Badge key={name} variant="light" color={badgeColor.done}>
                {name}
              </Badge>
            ))}
          </Group>
        )}
      </Card>
    </RosterSection>
  )
}
