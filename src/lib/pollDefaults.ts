import type { PollMode } from './types'

/**
 * The settings a new poll's form starts from: who can vote and the four
 * switches under *Configuration*, as they were on the last poll this browser
 * made.
 *
 * **Saved when a poll is made, not as a switch is flipped**, so a form
 * abandoned half-way through changes nothing, and what comes back is a set of
 * settings somebody actually chose together. A duplicate saves too: it is a
 * poll made with those settings like any other.
 *
 * **Per browser, like the clock and the sign-in method**: a habit of the
 * person at this device, kept with no migration and nothing to wait for before
 * the form is drawn. Only a starting point — every setting stays editable, and
 * a duplicate is filled from its source instead.
 */

export type PollDefaults = {
  mode: PollMode
  showVoters: boolean
  showBallots: boolean
  solicitOptions: boolean
  multiQuestion: boolean
}

const STORAGE_KEY = 'star-voting:poll-defaults'

/** A blank form's settings when nothing has been saved. */
const FALLBACK: PollDefaults = {
  mode: 'invite',
  showVoters: false,
  showBallots: false,
  solicitOptions: false,
  multiQuestion: false,
}

/**
 * The saved settings, each field checked on its own, so a field this build
 * does not recognise (or a damaged value) falls back alone.
 */
export function readPollDefaults(): PollDefaults {
  let stored: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>
  } catch {
    // Private browsing, storage disabled, or not JSON: the fallback stands.
  }
  const flag = (key: Exclude<keyof PollDefaults, 'mode'>) =>
    typeof stored[key] === 'boolean' ? stored[key] : FALLBACK[key]
  return {
    mode: stored.mode === 'open' || stored.mode === 'invite' ? stored.mode : FALLBACK.mode,
    showVoters: flag('showVoters'),
    showBallots: flag('showBallots'),
    solicitOptions: flag('solicitOptions'),
    multiQuestion: flag('multiQuestion'),
  }
}

/** Remembers a made poll's settings for the next blank form. */
export function savePollDefaults(defaults: PollDefaults): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults))
  } catch {
    // The next form starts from the fallback.
  }
}
