/**
 * Every badge colour the app uses, in one place.
 *
 * Badges from different files land next to each other all the time — a poll
 * list card carries the three setting tags, a turnout count and a vote
 * reminder in the same few square inches — so picking a colour at the call
 * site is how two unrelated meanings end up sharing one. Colours are chosen
 * here instead, against the whole set, and no two distinct meanings share.
 *
 * Three rules keep it that way:
 *
 *  1. **Every state of a setting gets its own colour**, not one colour per
 *     setting. `PollTags` always shows all three settings whichever way each
 *     is set, so a shared colour per pair meant the colour told you which
 *     question was being answered but not what the answer was — leaving the
 *     text to carry it alone.
 *  2. **The progress colours carry one meaning each, everywhere.** Reusing
 *     `done` for "results ready", "this person voted" and "this tie-break
 *     step settled it" is not a collision: it is the same claim about three
 *     different things, and it is what makes the colour worth reading.
 *  3. **A plain number gets no hue at all** — see `countBadge`.
 *
 * Anything new gets a key here first. If nothing distinct is left, that is a
 * signal the badge is one too many, not a reason to double up.
 */
export const badgeColor = {
  // The three settings a poll is frozen with. The two states of one setting
  // never appear together, so what these are spaced against is the *other*
  // settings on the same row -- which is why the pairs are not same-family.
  openLink: 'grape',
  inviteOnly: 'violet',
  respondentsShown: 'cyan',
  respondentsHidden: 'blue',
  ballotsPublished: 'teal',
  ballotsPrivate: 'pink',

  /** A state rather than a setting, so it is grey and always sits last. */
  closed: 'gray',

  /** Finished: results are ready, this person voted, this step was decisive. */
  done: 'green',
  /** Still owed: your vote is pending, this invitee hasn't voted yet. */
  outstanding: 'orange',
  /** A tie-break step that ran and settled nothing. */
  unsettled: 'yellow',
} as const

/**
 * A plain number the app is reporting — turnout, a response count, a placing.
 *
 * Neutral rather than coloured, and the one badge here that isn't. A count
 * makes no claim that a colour could carry: it is not good, bad, pending or
 * settled, it is just how many. Giving it a hue also cost more than it paid,
 * because the hue nearest a neutral blue was already spoken for by a setting
 * tag sitting inches away on the same card.
 */
export const countBadge = { variant: 'default' } as const
