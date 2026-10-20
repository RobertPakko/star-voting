/*
 * Guarded `localStorage` access for per-browser flags. Storage can throw
 * (private windows, blocked site data), and every caller here would rather
 * carry on without it.
 */

/** Whether `key` holds the flag. False when storage is unavailable. */
export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** Sets or clears the flag; silently does nothing when storage is unavailable. */
export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // Kept for this page only.
  }
}
