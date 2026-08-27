import { Divider, TextInput } from '@mantine/core'
import { VOTER_NAME_MAX } from '../lib/limits'
import type { VoterName } from '../lib/voterName'

/**
 * The field, with the rule under it that separates it from the rest of the
 * card. Both cards draw it at the top, above the strip, and so does the
 * stand-in a crossing puts up.
 */
export function VoterNameField({ name }: { name: VoterName }) {
  return (
    <>
      <TextInput
        ref={name.ref}
        label="Your name"
        placeholder="Your name"
        value={name.value}
        onChange={(e) => name.onChange(e.currentTarget.value)}
        error={name.error}
        maxLength={VOTER_NAME_MAX}
        required
        /* Label the key "Done" rather than a Go/newline the field has no use
           for, and honour that label by putting the keyboard away: the field
           stands alone rather than in a form, so Enter has nothing to submit
           and would only leave the keyboard up. */
        enterKeyHint="done"
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          name.blur()
        }}
      />
      <Divider />
    </>
  )
}
