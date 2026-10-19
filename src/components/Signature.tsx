import { Text } from '@mantine/core'
import classes from './Signature.module.css'

/**
 * "— Rob", in a hand rather than in type, under the notes on the donate and
 * contact pages. One component so the two cannot come to be signed in two
 * different ways — and because the face it is set in is cut down to exactly
 * these five characters (see Signature.module.css), so it is not a style to
 * reach for with any other text.
 */
export function Signature() {
  return <Text className={classes.signature}>— Rob</Text>
}
