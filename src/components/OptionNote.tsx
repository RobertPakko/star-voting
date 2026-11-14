import { ActionIcon, Popover, Stack, Text } from '@mantine/core'
import { InfoIcon } from '@phosphor-icons/react'
import { useOptionDescription } from '../lib/optionDescriptions'
import { OptionDescription } from './OptionDescription'

/**
 * An option's description, folded into a popover beside its name wherever a
 * result names it (a tooltip can't be opened on a phone). Drawn only for an
 * option that has one: `description` where the caller holds it, otherwise the
 * one `OptionDescriptions` holds for `id`.
 */
export function OptionNote({
  id,
  name,
  description,
}: {
  id: string
  name: string
  description?: string | null
}) {
  const held = useOptionDescription(id)
  const text = description ?? held
  if (!text) return null

  return (
    <Popover width={280} position="bottom-start" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          radius="xl"
          aria-label={`What ${name} said`}
          style={{ flexShrink: 0 }}
        >
          <InfoIcon size={14} aria-hidden />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {name}
          </Text>
          <OptionDescription description={text} />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
