import { Badge, Card, Group, Stack, Text, Title } from '@mantine/core'
import { badgeColor } from '../lib/badgeColors'

/**
 * The names themselves, for the two rosters that are nothing but names: no
 * pending column, no controls, and a line saying so while there are none.
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
    <Stack gap={0}>
      <Title order={4}>{title}</Title>
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
    </Stack>
  )
}
