/**
 * How long the things people type are allowed to be, in one place.
 *
 * Every one of them is also enforced in the database — `insert_option` for
 * the three about an option, `insert_poll_row` for the title and description,
 * `create_poll_group` for the question count — and this file exists so the
 * form can say *which box* is wrong instead of relaying a refusal. Change a
 * number here and change it there in the same breath; the two disagreeing is
 * a field the form accepts and the server rejects.
 *
 * All of them are checked on submit rather than enforced by the field. A
 * `maxLength` that silently swallows the tail of a pasted paragraph tells the
 * writer nothing; a field that goes red and says how far over it is tells
 * them what to cut. The exception is a voter's name, which is one word and
 * already had a hard cap.
 */

export const TITLE_MAX = 100
export const POLL_DESCRIPTION_MAX = 500

/**
 * Matches `insert_option`. Raised from 100, which turned out to be a label's
 * length rather than an option's: real options carry a subtitle, an author, a
 * date, a "(vegetarian)", and a writer eight characters over was being asked
 * to abbreviate the thing being voted on. 150 is still a label; anything
 * longer belongs in the description.
 */
export const OPTION_NAME_MAX = 150
/**
 * Matches `insert_option`. Raised from 500 alongside the name: a description
 * is the one field on a ballot allowed to be prose — the case for an option,
 * a menu, a couple of caveats — and 500 was a paragraph where people were
 * writing two.
 */
export const OPTION_DESCRIPTION_MAX = 900
/**
 * Matches `insert_option`. A ballot is a list somebody has to read to the end
 * before scoring any of it, and one nobody reads to the end is not one
 * anybody can score honestly.
 */
export const MAX_OPTIONS = 50

/** A name beside a tick on an open poll's roster, not a field to write in. */
export const VOTER_NAME_MAX = 60

/**
 * "Too long, by this much" — the number a writer needs is how much to cut,
 * not what the ceiling was.
 */
export function tooLong(what: string, length: number, max: number): string {
  return `${what} can be ${max} characters; this one is ${length}. Trim ${length - max}.`
}

/**
 * How many questions one poll can ask. Matches `create_poll_group`.
 *
 * A ballot per question, each with its own options to read: a poll long
 * enough that people stop partway has later questions answered by fewer
 * people than its early ones, and there is no honest way to report that as
 * one result.
 */
export const MAX_QUESTIONS = 20
