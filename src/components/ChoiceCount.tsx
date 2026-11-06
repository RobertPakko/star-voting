import { Group, Select, Text } from '@mantine/core'
import { useId } from 'react'
import { CHOICE_NUMBERS } from '../lib/choices'

/**
 * How many places or winners to show, for a reader looking at the result
 * with another number than the poll was made with. The database counts every
 * place it holds (`poll_results_rows()`), so a different number is a cut of
 * the answer already on screen and costs no request. *All* shows them all.
 *
 * Offered only up to one fewer than the options: that many places is all of
 * them, which *All* already says.
 */
export function ChoiceCount({
  label,
  value,
  optionCount,
  onChange,
}: {
  label: string
  /** Null for all. */
  value: number | null
  optionCount: number
  onChange: (next: number | null) => void
}) {
  const id = useId()
  const numbers = CHOICE_NUMBERS.filter((n) => n < optionCount)
  if (numbers.length === 0) return null
  const shown = value !== null && numbers.includes(value) ? String(value) : 'all'

  return (
    <Group gap="xs" wrap="nowrap">
      <Text component="label" htmlFor={id} size="sm" c="dimmed">
        {label}
      </Text>
      <Select
        id={id}
        size="xs"
        w={80}
        allowDeselect={false}
        value={shown}
        onChange={(next) => onChange(next === null || next === 'all' ? null : Number(next))}
        data={[
          ...numbers.map((n) => ({ value: String(n), label: String(n) })),
          { value: 'all', label: 'All' },
        ]}
        comboboxProps={{ withinPortal: true }}
      />
    </Group>
  )
}
