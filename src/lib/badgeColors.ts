/**
 * Every badge colour the app uses, in one place.
 *
 * Badges from different files land next to each other all the time — a poll
 * list card carries the four setting tags, a turnout count and a vote
 * reminder in the same few square inches — so picking a colour at the call
 * site is how two unrelated meanings end up sharing one. Colours are chosen
 * here instead, against the whole set, and no two distinct meanings share.
 *
 * Three rules keep it that way:
 *
 *  1. **Every state of a setting gets its own colour**, not one colour per
 *     setting. `PollTags` always shows all four settings whichever way each
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
  // The settings a poll is frozen with that a card puts on screen. The two
  // states of one setting never appear together, so what these are spaced
  // against is the *other* settings on the same row -- which is why the
  // pairs are not same-family.
  //
  // Where the options came from is frozen with these three and is not here:
  // it is the one setting nobody scans for, and the row it was in had grown
  // past what anybody reads. See PollTags.
  openLink: 'grape',
  inviteOnly: 'violet',
  respondentsShown: 'cyan',
  respondentsHidden: 'blue',
  ballotsPublished: 'teal',
  ballotsPrivate: 'pink',

  /**
   * States rather than settings, so both are neutral where the settings
   * above them are coloured, and both sit after them. A poll has at most one
   * of these at a time: collecting comes before any vote, closed after the
   * last one.
   */
  collectingOptions: 'dark',
  closed: 'gray',

  /**
   * Finished: results are ready, this person voted, this step was decisive.
   * The poll list's winner badge is the same claim about a whole poll.
   */
  done: 'green',
  /**
   * Still owed: this invitee hasn't voted yet, this poll is still waiting on
   * the votes that will finish it.
   */
  outstanding: 'orange',
  /**
   * Ran and settled nothing: a tie-break step that decided no order, and a
   * whole election that elected nobody. The same claim one level up.
   */
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
