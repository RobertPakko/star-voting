/**
 * Every badge colour the app uses, in one place.
 *
 * Badges from different files land next to each other all the time; a poll
 * list card carries the four setting tags, a turnout count and a vote
 * reminder in the same few square inches; so picking a colour at the call
 * site is how two unrelated meanings end up sharing one. Colours are chosen
 * here instead, against the whole set, and no two distinct meanings share.
 *
 * Three rules keep it that way:
 *
 *  1. **Every state of a setting gets its own colour**, not one colour per
 *     setting. `PollTags` always shows all four settings whichever way each
 *     is set, so a shared colour per pair meant the colour told you which
 *     question was being answered but not what the answer was; leaving the
 *     text to carry it alone.
 *  2. **The progress colours carry one meaning each, everywhere.** Reusing
 *     `done` for "results ready", "this person voted" and "this tie-break
 *     step settled it" is not a collision: it is the same claim about three
 *     different things, and it is what makes the colour worth reading.
 *  3. **A plain number gets no hue at all**.
 *
 * Anything new gets a key here first. If nothing distinct is left, that is a
 * signal the badge is one too many, not a reason to double up.
 */
export const badgeColor = {
  openLink: 'grape',
  inviteOnly: 'violet',
  respondentsShown: 'cyan',
  respondentsHidden: 'blue',
  ballotsPublished: 'lime',
  ballotsPrivate: 'teal',

  /**
   * States rather than settings, so both are neutral where the settings
   * above them are coloured, and both sit after them. A poll has at most one
   * of these at a time: collecting comes before any vote, closed after the
   * last one.
   */
  collectingOptions: 'gray',
  /**
   * The poll has stopped. Beside the title it is the poll's own state; in the
   * roster it is that same fact said about one person — *Did not vote*, which
   * is what `outstanding` turns into once there is no longer anything owed.
   */
  closed: 'dark',

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
  /**
   * Nothing to claim. The question strip on a poll that has stopped taking
   * votes marks no question as done or outstanding: whether this reader
   * answered a given one is a fact about a ballot nobody can cast any more,
   * so the strip is left saying only which question is open and where the
   * others are.
   *
   * It shares `collectingOptions`' grey on purpose, and the two cannot be
   * confused because they cannot appear together: a poll showing its results
   * is not a poll collecting its options.
   */
  unmarked: 'gray',
} as const

/**
 * A plain number the app is reporting; turnout, a response count, a placing.
 *
 * Neutral rather than coloured, and the one badge here that isn't. A count
 * makes no claim that a colour could carry: it is not good, bad, pending or
 * settled, it is just how many. Giving it a hue also cost more than it paid,
 * because the hue nearest a neutral blue was already spoken for by a setting
 * tag sitting inches away on the same card.
 */
export const countBadge = { variant: 'default' } as const
