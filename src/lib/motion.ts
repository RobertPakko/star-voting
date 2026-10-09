/**
 * The app's motion scale, read from JavaScript.
 *
 * The scale lives on `:root` in index.css, and stays there: an animation run
 * through the Web Animations API cannot name a custom property, so it is
 * handed the value the property holds instead, read off the document at the
 * moment it starts. One copy of every number, which is the whole point of the
 * scale — see Motion in AGENTS.md.
 *
 * The fallbacks are the values index.css declares, for the one case where the
 * stylesheet has not reached the document yet.
 */

const FALLBACK_MS = { fast: 120, base: 200, slow: 500, travel: 450 } as const
const FALLBACK_EASE = 'cubic-bezier(0.2, 0, 0.2, 1)'

/** A duration from the scale, in milliseconds. */
export function motionMs(name: keyof typeof FALLBACK_MS): number {
  const raw = readToken(`--motion-${name}`)
  const ms = raw.endsWith('ms') ? parseFloat(raw) : raw.endsWith('s') ? parseFloat(raw) * 1000 : NaN
  return Number.isFinite(ms) ? ms : FALLBACK_MS[name]
}

/** The one curve everything moves on. */
export function motionEase(): string {
  return readToken('--motion-ease') || FALLBACK_EASE
}

/**
 * Whether the reader has asked for less motion. The stylesheet's own rule
 * cannot reach an animation started from script, so every one of those asks.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
