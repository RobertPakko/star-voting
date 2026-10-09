/**
 * Handing a link to somebody: the device's own share sheet where there is
 * one, and the clipboard where there is not.
 *
 * The share sheet is the better of the two by a distance on a phone — it is
 * where Messages, WhatsApp and the family group chat already are — and most
 * desktop browsers have one now too. Firefox on the desktop is the common
 * exception, and there the link is copied instead, which is what this button
 * did everywhere before it could share.
 */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed'

/**
 * Whether this browser has a share sheet to open. Read when the button is
 * drawn, so it can say which of the two it will do: *Share* where a sheet
 * will open, *Copy* where it will not.
 */
export function canShareNatively(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

/**
 * The message a share sends: a sentence, a blank line, and the link.
 *
 * **The link travels inside the text rather than as the share's `url`.**
 * Given both, every target joins them its own way — iMessage puts the link
 * first, some Android apps drop the text, some put the two on one line — so
 * the same press arrives looking different depending on where it was sent.
 * One string arrives as written. The chat apps still find the link in it and
 * draw its preview card; see Link previews in AGENTS.md.
 */
export function shareMessage(text: string, url: string): string {
  return `${text}\n\n${url}`
}

/**
 * Shares `url` with `text` above it, or copies the bare link where there is
 * no share sheet.
 *
 * The copy is the link alone, not the message: a button that says *Copy*
 * beside a link is expected to copy that link, and pasting it into a browser,
 * an email or a calendar invite all want the address and nothing else.
 *
 * `title` goes along too. Most targets ignore it; the ones that do not use it
 * as an email's subject, which is where a poll's name belongs.
 */
export async function shareLink({
  title,
  text,
  url,
}: {
  title: string
  text: string
  url: string
}): Promise<ShareOutcome> {
  const data: ShareData = { title, text: shareMessage(text, url) }
  if (canShareNatively() && (!navigator.canShare || navigator.canShare(data))) {
    try {
      await navigator.share(data)
      return 'shared'
    } catch (err) {
      // Closing the sheet without picking anything is an answer, not a
      // failure, and must not turn into a copy the reader did not ask for.
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
      // Anything else — a sheet that refused this data, a page that lost the
      // user activation — falls through to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/** Where a poll has got to, as far as what a shared link asks for. */
export type ShareStage = 'collecting' | 'voting' | 'finished'

/**
 * The sentence a poll's link arrives under, which says what the link is for
 * at the stage the poll is at: a poll collecting options is asking for
 * options, an open one for a vote, a finished one has a result to look at.
 */
export function shareSentence(title: string, stage: ShareStage): string {
  const name = `“${title}”`
  if (stage === 'finished') return `See the results of ${name}`
  if (stage === 'collecting') return `Help choose the options for ${name}`
  return `Vote in ${name}`
}
