/**
 * A poll's link, shortened without being weakened.
 *
 * A poll's id is its link (see shareLink.ts), and a v4 uuid written the way
 * Postgres writes it is 36 characters carrying 122 random bits -- about three
 * and a half bits per character, because hex spends four bits on every six its
 * alphabet could hold and then adds four hyphens. The same sixteen bytes in
 * base64url are 22 characters. Nothing is traded away for the fourteen that
 * go: it is the identical number, respelled in a denser alphabet.
 *
 * **The short form is a spelling, not an id.** It exists in URLs and nowhere
 * else. `polls.id` is still a uuid, every RPC that takes a `p_poll_id uuid`
 * still takes one, and every id this app holds in a variable, compares, or
 * keys storage by is the canonical form: `pollIdFromParam` converts the moment
 * a route reads its parameter and `pollPath` converts back the moment one is
 * written into a URL. Two spellings loose in the app would be a bug waiting to
 * happen -- `questionsCovered` decides a crossing from an arrival by comparing
 * ids, and `voterKeyFor` names a `localStorage` entry after one, which is also
 * why the conversion could not have been done the other way round: keying
 * storage by the short form would have orphaned the key of every browser that
 * has already voted.
 *
 * **Old links keep working.** `pollIdFromParam` accepts a full uuid as readily
 * as a short one, so every `#/polls/<uuid>` already pasted into a chat or sent
 * in an invitation email resolves exactly as it did. That is not a shim with a
 * date on it: this schema writes poll ids into email bodies, those bodies are
 * permanent, and there is no point at which it becomes safe to stop reading
 * the long form. It costs one regex.
 *
 * **The sample's ids are words and stay words.** `sample-dinner` is neither a
 * uuid nor 22 characters, so both directions hand it back untouched -- which
 * is the whole point of it being a word, since those links are meant to be
 * read aloud. See `isSampleId`.
 */

/** The canonical form Postgres renders a uuid in, which is what the id is. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Sixteen bytes of base64url. The length is the whole test: the alphabet
 * overlaps the sample's ids -- `-` is in it -- but the longest of those is
 * twenty characters, so nothing the About page links to can be mistaken for
 * one of these.
 */
const SHORT = /^[A-Za-z0-9_-]{22}$/

function toShort(uuid: string): string {
  const hex = uuid.replace(/-/g, '')
  let bytes = ''
  for (let i = 0; i < hex.length; i += 2) {
    bytes += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  }
  return btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function toUuid(short: string): string | null {
  let bytes: string
  try {
    // Twenty-two characters plus the padding a decoder expects is a clean
    // twenty-four, which is sixteen bytes.
    bytes = atob(short.replace(/-/g, '+').replace(/_/g, '/') + '==')
  } catch {
    return null
  }
  if (bytes.length !== 16) return null

  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

/**
 * Whether this is a poll id in the database's own spelling -- a uuid, which a
 * sample's word and a mistyped address are not. For anything about to be
 * handed to Postgres as a `uuid`, where one stray string fails the whole
 * request rather than just itself.
 */
export function isCanonicalPollId(id: string): boolean {
  return UUID.test(id)
}

/**
 * How a poll id is written into a URL: short where there is a short form, and
 * unchanged where there is not.
 */
export function shortPollId(pollId: string): string {
  return UUID.test(pollId) ? toShort(pollId) : pollId
}

/**
 * The poll id a route parameter means, in the one spelling the rest of the app
 * uses.
 *
 * Anything that is not a short form is handed back as it came -- a full uuid,
 * a sample's word, and equally a mistyped address, which belongs to the read
 * that is about to fail on it rather than to this. Deciding here that an
 * address is not a poll would only move "poll not found" somewhere it cannot
 * be said as well.
 */
export function pollIdFromParam(param: string): string {
  if (!SHORT.test(param)) return param
  return toUuid(param) ?? param
}

/** The in-app path of a poll, which is the one place its address is spelled. */
export function pollPath(pollId: string): string {
  return `/polls/${shortPollId(pollId)}`
}
