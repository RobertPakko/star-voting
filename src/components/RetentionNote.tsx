import { Text } from '@mantine/core'

/** How long before deletion the note starts saying it out loud. */
const WARN_WITHIN_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When this poll will be deleted, for the person who can do something about
 * it.
 *
 * Polls are removed six months after creation, and what makes an automatic
 * deletion fair is that it was never a surprise: the date is on the poll from
 * the day it exists, on the same page as the result it will take with it. It
 * never moves, so this line says the same thing on the last day as the first.
 *
 * **Only the creator is told.** A retention date is a thing to *act* on, and
 * the only act there is belongs to the creator — duplicate the poll, which
 * nobody else has a button for. For a respondent it is a deadline about
 * somebody else's poll with nothing on the other end of it. The policy itself
 * is public, on the About page.
 *
 * A quiet line for almost all of a poll's life, and a warning in the last
 * month, when there is still time to do something about it.
 *
 * `expiresAt` is missing against a database whose `poll_status` predates the
 * column, and then this renders nothing: a retention date is only worth
 * showing when it is the real one.
 */
export function RetentionNote({ expiresAt }: { expiresAt?: string | null }) {
  if (!expiresAt) return null

  const when = new Date(expiresAt)
  if (Number.isNaN(when.getTime())) return null

  const daysLeft = Math.ceil((when.getTime() - Date.now()) / DAY_MS)
  const soon = daysLeft <= WARN_WITHIN_DAYS

  return (
    <Text size="xs" c={soon ? 'orange' : 'dimmed'} ta="center">
      {daysLeft <= 0
        ? 'This poll is past its six-month retention window and will be deleted shortly.'
        : `${soon ? 'This poll will be deleted on' : 'Kept until'} ${formatDate(when)}. Polls are deleted six months after they are created.`}
      {soon &&
        ' Duplicate it to start a fresh copy: the options and invitees carry over, the votes do not.'}
    </Text>
  )
}

/**
 * The date in the reader's own locale and in words: this is a deadline
 * somebody may have to remember, and 03/09/2026 means two different days
 * depending on which side of an ocean it is read on.
 */
function formatDate(when: Date): string {
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}
