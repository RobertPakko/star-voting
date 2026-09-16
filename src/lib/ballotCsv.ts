import type { BallotSheet } from './types'

/**
 * A poll's published ballots as a file somebody can open somewhere else.
 *
 * `show_ballots` exists so a tally can be checked rather than trusted, and the
 * grid on the page is only half of that: it can be read, and on a poll of any
 * size it cannot be *added up* -- which is the whole of what checking a STAR
 * result means. A spreadsheet can. So the same rows the grid draws are offered
 * as a download beside it, and the reader takes the arithmetic somewhere this
 * app has no part in.
 *
 * It is deliberately a small control and not a feature. Nothing new is
 * disclosed -- this is the sheet already on screen, gated in the database on
 * exactly the terms it is gated on there -- and nobody has to press it for the
 * page to make sense.
 */

/**
 * The rows: a heading, then one line per ballot, and nothing else.
 *
 * **No totals line**, unlike the grid, and that is the point rather than an
 * omission. The totals are the claim this file exists to let somebody test,
 * and a claim written into the evidence is a row every tool that opens this
 * would have to be told to ignore. One `SUM` puts it back.
 *
 * Ordered exactly as the grid orders it, which is the order the database
 * answered with: by name where there are names and by nothing at all where
 * there are none. Re-sorting an unnamed sheet here would invent an order and
 * hand it to a reader as though the poll had one.
 */
export function ballotsCsv(sheet: BallotSheet): string {
  const head = [sheet.voters_named ? 'Voter' : 'Ballot', ...sheet.options.map((o) => o.name)]
  const rows = sheet.ballots.map((ballot, i) => [
    // The grid draws an unnamed ballot as `#1`; the number alone is the same
    // fact in a column something is going to read as data.
    sheet.voters_named ? (ballot.voter ?? '') : String(i + 1),
    // Unscored reads as 0, exactly as it does everywhere else in the app, so
    // the columns add up to what the tally says. See `Ballots`.
    ...sheet.options.map((o) => String(ballot.scores[o.id] ?? 0)),
  ])

  // CRLF, which is what RFC 4180 says a CSV row ends with. Every tool that
  // reads one of these takes a bare LF too, and the one that is fussiest about
  // it is the spreadsheet most of these files will be opened in.
  return [head, ...rows].map((row) => row.map(field).join(',')).join('\r\n')
}

/**
 * One field, escaped.
 *
 * Two rules, and the second is not about CSV at all. Quoting anything holding
 * a comma, a quote or a line break is the format; **a leading `=`, `+`, `-` or
 * `@` is a formula** to every spreadsheet that opens the file, and the names
 * and options in this sheet were typed by whoever holds the poll's link. A
 * file this app hands somebody to open in Excel must not be a way to run
 * something in it, so such a field gets a leading apostrophe -- which is the
 * spreadsheet's own "this is text", and visible, which is better than the
 * alternative being invisible.
 */
function field(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

/**
 * What the file is called: the poll, the question where there is one, and
 * `-ballots.csv`.
 *
 * The same reduction `qrFileName` makes, and for the same reason -- a title is
 * whatever somebody typed, and a filename is handed to a filesystem. A poll of
 * several questions publishes a sheet per question, so the question has to be
 * in the name or the second download lands beside the first as `(1)`.
 */
export function ballotsFileName(title: string, question?: string | null): string {
  const slug = [title, question]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `${slug || 'poll'}-ballots.csv`
}

/**
 * Hand the file to the browser.
 *
 * The byte-order mark is not decoration: without it Excel reads a UTF-8 CSV as
 * whatever its machine's legacy code page happens to be, so every voter whose
 * name is not plain ASCII opens the file misspelled. Every other reader of a
 * CSV skips the mark.
 *
 * The object URL is revoked once the click has been dispatched -- the download
 * has the blob by then, and a URL left behind pins it in memory for the life
 * of the document.
 */
export function downloadCsv(text: string, fileName: string): void {
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  link.click()
  URL.revokeObjectURL(href)
}
