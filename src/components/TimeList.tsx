import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Group, Stack, Text } from '@mantine/core'
import { PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react'
import { notifications } from '@mantine/notifications'
import { PaintTimes } from './PaintTimes'
import type { PaintedEdit } from './PaintTimes'
import { RollingBadge } from './PollTags'
import { formatDay, parseWindowStart } from '../lib/schedule'
import { sendDraft } from '../lib/optionWrites'
import type { DraftHold, OptionsSource } from '../lib/optionWrites'
import type { PollOption, PollSchedule } from '../lib/types'

/** The list on a time poll: painted on a calendar (`PaintTimes`), saved in one press. */
export function TimeList({
  source,
  options,
  schedule,
  isCreator,
  ownSave,
  draft,
  footer,
  onDirtyChange,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  schedule: PollSchedule
  isCreator: boolean
  ownSave: boolean
  draft: DraftHold
  /** The card's foot, handed the calendar's *Add times*. */
  footer: (addButton: ReactNode, ruled: boolean) => ReactNode
  onDirtyChange: (dirty: boolean) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The painting's difference from the list, as PaintTimes last reported it.
  const [painted, setPainted] = useState<PaintedEdit | null>(null)
  // No calendar until *Add times* is pressed, only a line saying what the
  // list holds (`TimesSummary`): a calendar that looked paintable and was not
  // read as broken. The creator's correction is already an editor, opened from
  // *Edit options*, so it starts editing.
  const [editing, setEditing] = useState(source.kind === 'creator')
  // Opening the calendar is starting an edit, as opening a text field is.
  const started = painted !== null || (editing && source.kind !== 'creator')

  const noteDraft = useCallback((edit: PaintedEdit | null) => {
    setPainted(edit)
  }, [])

  async function save(add: string[], removeIds: string[], quiet = false): Promise<boolean> {
    if (busy) return false
    // Nothing painted: only the calendar to close.
    if (add.length === 0 && removeIds.length === 0) return landed(add, removeIds, quiet)
    setError(null)
    setBusy(true)
    const { error: rpcError } = await sendDraft(source, {
      added: add.map((name) => ({ name, description: '' })),
      corrected: [],
      removed: removeIds,
    })
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return false
    }
    return landed(add, removeIds, quiet)
  }

  /** `quiet` saves are part of a closing press, which notifies and re-reads itself. */
  function landed(add: string[], removeIds: string[], quiet: boolean) {
    if (source.kind !== 'creator') {
      // The calendar goes, and the next one opens on the list as it then is.
      setEditing(false)
      setPainted(null)
    }
    if (quiet) return true

    notifications.show({
      message:
        add.length > 0
          ? `Added ${add.length} ${add.length === 1 ? 'time' : 'times'}`
          : `Removed ${removeIds.length} ${removeIds.length === 1 ? 'time' : 'times'}`,
      color: 'green',
    })
    onChanged()
    return true
  }

  useEffect(() => {
    onDirtyChange(started)
  }, [started, onDirtyChange])

  // Re-registered every render; see DraftHold. Held while the calendar is
  // open, so the closing press also closes one with nothing painted on it.
  useEffect(() => {
    draft.current = started ? () => save(painted?.add ?? [], painted?.removeIds ?? [], true) : null

    return () => {
      draft.current = null
    }
  })

  const addButton = (
    <Button
      variant="light"
      onClick={() => setEditing(true)}
      disabled={editing || busy}
      leftSection={
        isCreator ? <PencilSimpleIcon size={16} aria-hidden /> : <PlusIcon size={16} aria-hidden />
      }
    >
      {/* A creator's gestures take times off as well as putting them on. */}
      {isCreator ? 'Edit times' : 'Add times'}
    </Button>
  )

  return (
    <Stack gap="sm">
      {editing ? (
        <PaintTimes
          schedule={schedule}
          options={options}
          canRemove={isCreator}
          saving={busy}
          showSave={ownSave}
          onSave={save}
          onDraftChange={noteDraft}
        />
      ) : (
        <TimesSummary options={options} />
      )}
      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}
      {/* With no closing button on the card, the calendar's own *Save times*
          stands in for the foot once editing; before that, *Add times* does. */}
      {ownSave
        ? !editing && <Group justify="flex-end">{addButton}</Group>
        : footer(source.kind === 'creator' ? null : addButton, true)}
    </Stack>
  )
}

/**
 * What a time poll's list holds, before anybody opens the calendar: how many
 * windows, and the first and last day they fall on. Badges, because the list
 * moves while it is read (somebody else's suggestion landing), and a badge
 * whose words roll over shows that it did; see RollingBadge.
 */
function TimesSummary({ options }: { options: PollOption[] }) {
  const days = options
    .map((o) => parseWindowStart(o.name)?.day)
    .filter((day) => day !== undefined)
    .sort()

  if (days.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No times suggested yet.
      </Text>
    )
  }

  const first = days[0]
  const last = days[days.length - 1]
  return (
    <Group gap={6} wrap="wrap">
      <RollingBadge
        label={`${options.length} ${options.length === 1 ? 'time option' : 'time options'}`}
      />
      {/* The range is one item of the row, so a narrow card moves it onto a
          line of its own whole rather than breaking it after "from X to";
          it only wraps inside itself where even a line of its own is too
          narrow. */}
      <Group gap={6} wrap="wrap">
        {first === last ? (
          <>
            <Text size="sm" span>
              on
            </Text>
            <RollingBadge label={formatDay(first)} />
          </>
        ) : (
          <>
            <Text size="sm" span>
              from
            </Text>
            <RollingBadge label={formatDay(first)} />
            <Text size="sm" span>
              to
            </Text>
            <RollingBadge label={formatDay(last)} />
          </>
        )}
      </Group>
    </Group>
  )
}
