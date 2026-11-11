import { Autocomplete, Divider, TextInput } from '@mantine/core'
import { VOTER_NAME_MAX } from '../lib/limits'
import type { VoterName } from '../lib/voterName'

/**
 * The field, with the rule under it that separates it from the rest of the
 * card. Both cards draw it at the top, above the strip, and so does the
 * stand-in a crossing puts up.
 */
export function VoterNameField({
  name,
  disabled,
  value,
  suggestions,
}: {
  name: VoterName
  /** Once the answer is in; Edit vote enables it again. */
  disabled?: boolean
  /** What a disabled box shows instead of what is typed (the name the ballot carries). */
  value?: string
  /**
   * On a sequential poll, the earlier voters still to vote: offered as a list
   * to pick from, so a ballot carries its weight from earlier polls. Any other
   * name is a newcomer's, so the box still takes one typed in.
   */
  suggestions?: string[]
}) {
  if (suggestions && !disabled) {
    return (
      <>
        <Autocomplete
          ref={name.ref}
          label="Your name"
          description="Pick your name from earlier polls, or type a new one."
          placeholder="Your name"
          data={suggestions}
          value={name.value}
          onChange={name.onChange}
          error={name.error}
          maxLength={VOTER_NAME_MAX}
          required
          enterKeyHint="done"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            name.blur()
          }}
        />
        <Divider />
      </>
    )
  }

  return (
    <>
      <TextInput
        ref={name.ref}
        label="Your name"
        placeholder="Your name"
        value={disabled && value !== undefined ? value : name.value}
        onChange={(e) => name.onChange(e.currentTarget.value)}
        error={name.error}
        maxLength={VOTER_NAME_MAX}
        required
        disabled={disabled}
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
