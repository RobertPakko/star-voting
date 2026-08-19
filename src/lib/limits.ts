/**
 * How long the things people type are allowed to be, in one place.
 *
 * Three of these are not the form's own idea: `add_suggested_option` in the
 * database has capped a suggested option at 100 characters, its description
 * at 500, and a poll at 50 options since options could be suggested at all.
 * Those limits were written for the one field a whole group can write to,
 * but they are the answer to the same question the create form asks — how
 * long is a label on a ballot, and how long is the note under it — and a
 * poll whose options came from its creator has to be scored by the same
 * people reading the same ballot. So the form applies them too, rather than
 * letting the two paths into `candidates` disagree about what fits.
 *
 * The two poll-level limits are the form's alone: nothing in the database
 * bounds a title or a poll description, and nothing here is a security
 * measure. They exist so a title stays a title.
 *
 * Every one of them is checked when the form is submitted rather than
 * enforced by the field, deliberately. A `maxLength` that silently swallows
 * the tail of a pasted paragraph tells the writer nothing; a field that goes
 * red and says how far over it is tells them exactly what to cut. The one
 * exception is a field that already had a hard cap and is a single word
 * anyway — a voter's name on an open ballot.
 */

export const TITLE_MAX = 100
export const POLL_DESCRIPTION_MAX = 500

/** Matches `add_suggested_option`; see above. */
export const OPTION_NAME_MAX = 100
/** Matches `add_suggested_option`; see above. */
export const OPTION_DESCRIPTION_MAX = 500
/**
 * Matches `add_suggested_option`. A ballot is a list somebody has to read to
 * the end before scoring any of it, and one nobody reads to the end is not
 * one anybody can score honestly.
 */
export const MAX_OPTIONS = 50

/** A name beside a tick on an open poll's roster, not a field to write in. */
export const VOTER_NAME_MAX = 60

/**
 * "Too long, by this much." Written as the gap rather than the limit,
 * because the number a writer needs is how much to cut, not what the ceiling
 * was.
 */
export function tooLong(what: string, length: number, max: number): string {
  return `${what} can be ${max} characters; this one is ${length}. Trim ${length - max}.`
}
