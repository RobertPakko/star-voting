import { useEffect, useRef, useState, type RefObject } from 'react'

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

/**
 * The box an open poll asks a voter's name in, and the one copy of what is
 * typed into it.
 *
 * A share link carries no account, so a poll that shows who has responded has
 * to ask — on the ballot, and on the card the option list is confirmed from,
 * which is the same field in the same place at two stages of the same poll.
 * It was written out twice, once in each card, down to the comment explaining
 * `enterKeyHint`; `VoterNameField` is that field, once, and this is what it
 * draws from.
 *
 * **The state lives above the card, in the page.** A name is not a fact about
 * a question — it is what this person is called, the same on question 5 as on
 * question 1, which is the whole reason the storage above carries it from one
 * question to the next. Held inside the card it also *ended* with the card:
 * crossing between two questions unmounts that card, so a name typed but not
 * yet sent was thrown away by the crossing, and the box itself blinked out
 * with everything else while the next question was read. Held in the page,
 * which stays mounted across a crossing, it is one field that goes on
 * standing there — the stand-in a crossing puts up draws this same node, so
 * nothing about it moves.
 *
 * The page therefore holds it with `useVoterName` and hands the result to
 * whichever card is up.
 */
export type VoterName = {
  /** What is in the box, and what the field draws. */
  value: string
  /** What it is worth sending: the same, trimmed. */
  trimmed: string
  /** What is wrong with it, marked on the box rather than beside a button. */
  error: string | null
  /** The box itself, for the focus and blur below. */
  ref: RefObject<HTMLInputElement | null>
  /** Somebody typed; a complaint about what was there stops applying. */
  onChange: (value: string) => void
  /**
   * The one thing to be happy about before a ballot or a confirmation is
   * sent. False, with the complaint on the box and the cursor in it, when
   * there is no name to send. The wording is the caller's because only the
   * card knows what it is about to do with it.
   */
  check: (complaint: string) => boolean
  /**
   * Drop focus. Dismissing the on-screen keyboard on a phone does not blur
   * the field it belongs to, so focus never leaves this box on its own and
   * every star a voter then taps pops the keyboard back up over the ballot.
   */
  blur: () => void
  /**
   * Remember it, once something has actually gone in under it — a name the
   * server refused is not offered back on the next poll. See lib/voterName.ts.
   */
  remember: () => void
}

/**
 * The name, held for as long as the page is on screen.
 *
 * `question` is the address being read. It is not what the name belongs to —
 * that is the browser — but a *complaint* about the name belongs to the card
 * it was made on, so crossing to another question clears it and leaves what
 * was typed alone.
 */
export function useVoterName(question: string | undefined): VoterName {
  // Offered rather than imposed: the name this browser last voted or
  // confirmed under, editable like any other, and blank for a browser that
  // has not. See lib/voterName.ts for why the browser is the one place
  // entitled to carry it from one question to the next.
  const [value, setValue] = useState(rememberedVoterName)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => setError(null), [question])

  return {
    value,
    trimmed: value.trim(),
    error,
    ref,
    onChange(next) {
      setValue(next)
      setError(null)
    },
    check(complaint) {
      setError(null)
      if (value.trim()) return true
      setError(complaint)
      ref.current?.focus()
      return false
    },
    blur() {
      ref.current?.blur()
    },
    remember() {
      rememberVoterName(value)
    },
  }
}
