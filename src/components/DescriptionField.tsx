import { ActionIcon, Textarea, Tooltip, type TextareaProps } from '@mantine/core'
import classes from './DescriptionField.module.css'

/**
 * The box for an option's description, wherever an option is being written:
 * the create form, and the option list on a poll collecting its options or
 * being corrected by its creator.
 *
 * The field says what it is by its shape. It is indented under the name it
 * belongs to, with an elbow drawn from the bottom of that field across to its
 * left edge (`DescriptionField.module.css`); indenting alone reads as an
 * unrelated field that happens to be narrower, and the elbow is the shape a
 * file tree already uses for "belongs to the thing above".
 *
 * It opens two rows tall rather than one, because a field the same height as
 * the name above it looks like another one-line answer, and it grows from
 * there instead of scrolling.
 */
export function DescriptionField(props: TextareaProps) {
  return (
    <div className={classes.description}>
      <Textarea size="xs" autosize minRows={2} {...props} />
    </div>
  )
}

/**
 * The `+` / `−` beside an option that shows its description field or takes it
 * away, on every screen an option is written on. Taking it away is taking the
 * description away: hidden means gone, so no option carries text its writer
 * can no longer see.
 */
export function DescriptionToggle({
  open,
  subject,
  onToggle,
}: {
  /** Whether the description field is on screen. */
  open: boolean
  /** What the option is called in the button's accessible name. */
  subject: string
  onToggle: () => void
}) {
  return (
    <Tooltip label={open ? 'Remove description' : 'Add description'} withArrow>
      <ActionIcon
        variant="subtle"
        color="gray"
        onClick={onToggle}
        aria-label={
          open ? `Remove the description from ${subject}` : `Add a description to ${subject}`
        }
      >
        {open ? '−' : '+'}
      </ActionIcon>
    </Tooltip>
  )
}
