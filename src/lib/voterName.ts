/**
 * The name this browser last voted under, offered back on the next ballot.
 *
 * A poll that asks several questions is several polls under the hood, and an
 * open poll's ballots are identified by a `voter_key` that is deliberately
 * minted per question so that one browser's ballots cannot be joined to each
 * other; see `voterKey.ts` for what that scoping is worth. Nothing on the
 * server therefore knows that the person answering question 2 is the one who
 * answered question 1, and nothing on the server should.
 *
 * So the continuity lives here instead, in the one place entitled to it: the
 * voter's own browser. Typing your name once and having it offered back is a
 * convenience the browser can provide alone, and providing it this way sends
 * nothing new anywhere — the name still reaches the server only when a ballot
 * is submitted, and only for the question it was submitted to.
 *
 * **Stored per browser, not per poll.** A name is not a per-poll secret; it
 * is what this person is called, and it is the same on the next poll as on
 * this one. Somebody who answers under a pseudonym can overwrite it by
 * typing a different one, which is the same gesture as changing it.
 *
 * It is only ever a suggestion. Every ballot's name field starts filled in
 * and stays editable, and a poll that hides its respondents shows no field at
 * all — `open_poll_submit` discards the name on such a poll whatever the
 * client sends, so a remembered name cannot leak onto an anonymous ballot.
 */

const STORAGE_KEY = 'star-voting:voter-name'

/** The remembered name, or '' when there is none and for a browser with no storage. */
export function rememberedVoterName(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    // Private browsing, or storage disabled. The field simply starts empty.
    return ''
  }
}

/** Remembers the name a ballot went in under. Blank names are not remembered. */
export function rememberVoterName(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  try {
    localStorage.setItem(STORAGE_KEY, trimmed)
  } catch {
    // Nothing to do and nothing lost: the next ballot starts empty, which is
    // where this browser was anyway.
  }
}
