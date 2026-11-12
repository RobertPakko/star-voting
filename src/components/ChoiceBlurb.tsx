import type { ReactNode } from 'react'
import { Anchor, Modal, Text } from '@mantine/core'
import { Link } from 'react-router-dom'
import { choiceOf, choicePage } from '../lib/choices'
import type { PollKind } from '../lib/types'

/**
 * A kind in one sentence, its name in bold, with a link to where `/choices`
 * explains it: the same sentence that section opens with. Drawn in every
 * result's modal and the results page's info popover, so a result describes
 * itself in one set of words. On a calendar it speaks of times.
 */
export function ChoiceBlurb({ kind, calendar }: { kind: PollKind; calendar: boolean }) {
  const { label, blurb } = choiceOf(kind, calendar)
  return (
    <Text size="sm">
      <strong>{label}</strong> {blurb}{' '}
      <Anchor component={Link} to={choicePage(kind)} inherit>
        Learn more
      </Anchor>
    </Text>
  )
}

/**
 * A *More results* modal: the blurb stands where a title would, beside the
 * close button, and names the dialog, since it starts with the kind's name.
 */
export function ChoiceModal({
  kind,
  calendar,
  opened,
  onClose,
  children,
}: {
  kind: PollKind
  /** Whether the options are a calendar's (`PollResults.calendar`). */
  calendar: boolean
  opened: boolean
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={<ChoiceBlurb kind={kind} calendar={calendar} />}
    >
      {children}
    </Modal>
  )
}
