import { Button, type MantineSpacing } from '@mantine/core'
import { ArrowLeftIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'

/**
 * The way back to the home page, at the top of every page but the home page
 * itself — drawn by `Layout` for the pages in the shell, and by the pages
 * outside it for themselves. A poll page carries `BackToList` instead when the
 * reader has a list, since the list is one step nearer home and itself leads
 * back here. Drawn exactly as `BackToList` is, so the two read as one control.
 *
 * `mb` is for the poll list, which draws it in a row with its own buttons.
 */
export function BackToHome({ mb = 'sm' }: { mb?: MantineSpacing | 0 }) {
  return (
    <Button
      component={Link}
      to="/"
      variant="subtle"
      color="gray"
      size="compact-sm"
      leftSection={<ArrowLeftIcon size={16} aria-hidden />}
      mb={mb}
    >
      Back to homepage
    </Button>
  )
}
