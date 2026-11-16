import { Button, Group, Stack, Text } from '@mantine/core'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react'

/** An option the reader has taken out of a count, named as it was shown. */
export interface LeftOut {
  id: string
  name: string
}

/**
 * The line over every count a reader can take options out of. One sentence
 * for all of them, so the same act is described the same way in each modal.
 */
export function RemoveHint() {
  return (
    <Text size="sm" c="dimmed">
      If an option is not available, remove it to see the result without it.
    </Text>
  )
}

/**
 * The options taken out of *Multiple winners* or *Fractional winners*, each a
 * button that puts it back, and *Restore all* once there are two. Draws
 * nothing while nothing is out.
 */
export function RemovedOptions({
  leftOut,
  onRestore,
  onRestoreAll,
}: {
  leftOut: LeftOut[]
  onRestore: (id: string) => void
  onRestoreAll: () => void
}) {
  if (leftOut.length === 0) return null

  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>
        Removed
      </Text>
      <Group gap="xs">
        {leftOut.map((option) => (
          <Button
            key={option.id}
            variant="default"
            size="compact-sm"
            leftSection={<ArrowCounterClockwiseIcon size={14} aria-hidden />}
            onClick={() => onRestore(option.id)}
            aria-label={`Restore ${option.name}`}
            style={{ maxWidth: '100%' }}
          >
            {/* The button's line-height of 1 would let the truncating box
                clip descenders; the name needs a line of its own height. */}
            <Text span inherit truncate lh={1.4}>
              {option.name}
            </Text>
          </Button>
        ))}
        {leftOut.length > 1 && (
          <Button variant="subtle" size="compact-sm" onClick={onRestoreAll}>
            Restore all
          </Button>
        )}
      </Group>
    </Stack>
  )
}
