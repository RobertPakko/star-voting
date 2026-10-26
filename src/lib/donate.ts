/**
 * The Donate page's charity, and the fundraiser on Every.org that counts
 * what this site has raised for it. See "The donate page" in AGENTS.md.
 *
 * All three are public: the slugs are in the donate link anybody can see, and
 * the key is Every.org's *publishable* one, made for a browser to send. So
 * they live here rather than in `.env`, where a value only stays out of the
 * repository if it has to.
 */
const EVERY_ORG = {
  /** Khan Academy, EIN 26-1544963. */
  nonprofit: 'khan-academy',
  /**
   * The fundraiser's slug, the part after `/f/` in its address. Empty until
   * there is one: the button then gives to the charity directly, and the
   * page draws no count.
   */
  fundraiser: 'make-world-class-education',
  /** From every.org/charity-api. The count is read only once this is set. */
  publicKey: 'pk_live_a9fb22e9b80a8254960fba3663f07e0b',
}

/** Where the donate button goes: Every.org's donation form, over the fundraiser. */
export function donateUrl(): string {
  const { nonprofit, fundraiser } = EVERY_ORG
  const page = fundraiser ? `${nonprofit}/f/${fundraiser}` : nonprofit
  return `https://www.every.org/${page}#donate`
}

/**
 * What the fundraiser has raised, in whole dollars, and from how many people;
 * and what it is aiming for, which is null where it has no goal at all.
 */
export interface Raised {
  dollars: number
  supporters: number
  goal: {
    dollars: number
    /**
     * Whether Every.org set the goal rather than whoever made the fundraiser:
     * its "smart milestones", which move up each time one is reached. So it
     * is the next milestone, not the finish line, and the page says so.
     */
    milestone: boolean
  } | null
}

/** Whether there is a fundraiser to ask, which is whether the page draws a count. */
export const countsRaised = Boolean(EVERY_ORG.fundraiser && EVERY_ORG.publicKey)

/**
 * The fundraiser's totals, from Every.org's partner API — which answers any
 * origin, so the browser asks it directly. Null for anything but a clean
 * answer: the count is a nicety beside the button, and a page that says
 * nothing about it is better than one that says something wrong.
 */
export async function fetchRaised(signal?: AbortSignal): Promise<Raised | null> {
  if (!countsRaised) return null
  const { nonprofit, fundraiser, publicKey } = EVERY_ORG
  const url =
    `https://partners.every.org/v0.2/nonprofit/${encodeURIComponent(nonprofit)}` +
    `/fundraiser/${encodeURIComponent(fundraiser)}/raised?apiKey=${encodeURIComponent(publicKey)}`
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return null
    const body: {
      raised?: unknown
      supporters?: unknown
      goalAmount?: unknown
      goalType?: unknown
    } = await response.json()
    // The amounts are in cents, and arrive as strings of digits rather than
    // numbers; `supporters` is a number. Each is read whichever it is.
    const cents = Number(body.raised)
    const supporters = Number(body.supporters)
    if (!Number.isFinite(cents) || !Number.isFinite(supporters)) return null
    const goalCents = Number(body.goalAmount)
    const goal =
      Number.isFinite(goalCents) && goalCents > 0
        ? { dollars: Math.floor(goalCents / 100), milestone: body.goalType === 'AUTOMATIC' }
        : null
    return { dollars: Math.floor(cents / 100), supporters, goal }
  } catch {
    return null
  }
}
