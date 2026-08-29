/**
 * Every badge colour the app uses, in one place.
 *
 * Badges from different files land next to each other constantly — a poll
 * list card carries four setting tags, a turnout count and a state badge in
 * the same few square inches — so picking a colour at the call site is how two
 * unrelated meanings end up sharing one. They are chosen here instead, against
 * the whole set, and no two distinct meanings share.
 *
 * Three rules keep it that way:
 *
 *  1. **Every state of a setting gets its own colour**, not one per setting.
 *     `PollTags` always shows all four settings whichever way each is set, so
 *     one colour per pair told you which question was being answered but not
 *     what the answer was.
 *  2. **The progress colours carry one meaning each, everywhere.** `done` on
 *     "results ready", "this person voted" and "this tie-break settled it" is
 *     not a collision: it is the same claim about three things, and that is
 *     what makes the colour worth reading.
 *  3. **A plain number gets no hue at all.**
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
   * States rather than settings, so both are neutral where the settings above
   * are coloured. A poll has at most one at a time: collecting comes before
   * any vote, closed after the last one.
   */
  collectingOptions: 'gray',
  /**
   * The poll has stopped. Beside the title it is the poll's own state; in the
   * roster it is that same fact about one person — *Did not vote*, which is
   * what `outstanding` turns into once nothing is owed.
   */
  closed: 'dark',

  /** Finished: results ready, this person voted, this step was decisive. */
  done: 'green',
  /** Still owed: this invitee hasn't voted, this poll is still waiting. */
  outstanding: 'orange',
  /**
   * Ran and settled nothing: a tie-break step that decided no order, and a
   * whole election that elected nobody. The same claim one level up.
   */
  unsettled: 'yellow',
  /**
   * Nothing to claim — the question strip on a poll that has stopped taking
   * votes, where whether this reader answered a given question is a fact about
   * a ballot nobody can cast any more.
   *
   * It shares `collectingOptions`' grey on purpose, and the two cannot be
   * confused because they cannot appear together: a poll showing its results
   * is not a poll collecting its options.
   */
  unmarked: 'gray',
} as const

/**
 * A plain number the app is reporting: turnout, a response count, a placing.
 *
 * Neutral rather than coloured, and the one badge here that isn't. A count
 * makes no claim a colour could carry — it is not good, bad, pending or
 * settled, it is just how many — and the hue nearest a neutral blue was
 * already spoken for by a setting tag inches away on the same card.
 */
export const countBadge = { variant: 'default' } as const
