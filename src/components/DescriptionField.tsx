import { Textarea, type TextareaProps } from '@mantine/core'
import classes from './DescriptionField.module.css'

/**
 * The box for an option's description, wherever an option is being written:
 * the create form, and the suggestion form on a poll collecting its options.
 *
 * The field says what it is by its shape. It is indented under the name it
 * belongs to, with an elbow drawn from the bottom of that field across to its
 * left edge (`DescriptionField.module.css`) — indenting alone reads as an
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
