import { useState } from 'react'
import { Button, Card, Group, Stack, Text, Title } from '@mantine/core'
import { DatePicker } from '@mantine/dates'
import { ArrowRightIcon } from '@phosphor-icons/react'
import { formatDay, type ScheduleDay } from '../lib/schedule'
// Here rather than in main.tsx, so the stylesheet is split off with the
// create form, the one page that draws this.
import '@mantine/dates/styles.css'

/**
 * The step before the create form when a time poll is duplicated: the copy is
 * nearly always about different dates, so the creator is shown where the
 * original started and asked where the copy should. Every painted day moves by
 * the same number of days, so the shape of the poll -- a Friday evening and
 * the Saturday after it -- comes across whole.
 */
export function DuplicateDates({
  from,
  suggested,
  today,
  onPick,
}: {
  /** The first day of the poll being copied. */
  from: ScheduleDay
  /** Where the picker starts: the same weekday, moved past today. */
  suggested: ScheduleDay
  /** The earliest day a poll may ask about, on the poll's own clock. */
  today: ScheduleDay
  onPick: (first: ScheduleDay) => void
}) {
  const [first, setFirst] = useState<ScheduleDay | null>(suggested)

  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1} size="h2" ta="center">
        Duplicate poll
      </Title>
      <Card withBorder p="md">
        <Stack gap="sm" align="center">
          <Text size="sm" c="dimmed" ta="center">
            The poll you are duplicating started on {formatDay(from)}, {from.slice(0, 4)}. Pick a
            start date for the new poll.
          </Text>
          <DatePicker
            value={first}
            onChange={setFirst}
            minDate={today}
            defaultDate={suggested}
            firstDayOfWeek={1}
            aria-label="First day of the new poll"
          />
          <Group justify="flex-end" w="100%">
            <Button
              disabled={!first}
              onClick={() => first && onPick(first)}
              rightSection={<ArrowRightIcon size={16} aria-hidden />}
            >
              Continue
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  )
}
