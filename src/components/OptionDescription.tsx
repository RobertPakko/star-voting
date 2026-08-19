import type { ReactNode } from 'react'
import { Anchor, Text } from '@mantine/core'

// A description is written by the poll's creator for the people they invited,
// and is the one place in the app where they might reasonably want to point
// somewhere else -- a menu, a spec, a candidate's write-up. So URLs in it are
// turned into links rather than left as text nobody can follow without
// selecting and copying it.
//
// Matched with a scheme, or with a bare "www." host, which is how people
// actually paste links. Everything else stays plain text: the href is either
// the matched "http(s)://…" or "https://" glued onto the "www." form, so
// there is no way to write a description that produces a javascript: or
// data: link, and nothing here is ever handed to dangerouslySetInnerHTML.
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi

// Sentence punctuation that follows a link far more often than it belongs to
// one: "see https://example.com/menu." ends a sentence, it does not link to a
// page whose path ends in a full stop.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/

function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let cursor = 0

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index
    const url = match[0].replace(TRAILING_PUNCTUATION, '')
    // The stripped punctuation is not dropped -- it goes back into the plain
    // text that follows the link.
    const end = start + url.length

    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(
      <Anchor
        key={start}
        href={url.toLowerCase().startsWith('www.') ? `https://${url}` : url}
        target="_blank"
        rel="noopener noreferrer"
        inherit
      >
        {url}
      </Anchor>,
    )
    cursor = end
  }

  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

/**
 * The optional detail under an option's name on a ballot. Line breaks are
 * kept, since a description of a few options is usually written as a few
 * lines, and a long URL wraps rather than pushing the card sideways.
 */
export function OptionDescription({ description }: { description: string }) {
  return (
    <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {linkify(description)}
    </Text>
  )
}
