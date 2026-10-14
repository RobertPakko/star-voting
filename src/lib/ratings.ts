/**
 * The six ratings a time poll's calendar is painted in, and the colours they
 * are drawn in -- shared by the ballot that paints them and the two results
 * cards that read them back, so a 3 is the same yellow wherever it is seen.
 *
 * **A ramp of hue, not of shade.** These were six blues from `blue.2` to
 * `blue.9`, which is a scale you can order but cannot read: a 2 and a 3 beside
 * each other on a week grid are two rectangles of nearly the same colour, and
 * the question a painted calendar is answering is "what did I put here". Red
 * through green is the ordering everybody already knows for "bad to good", and
 * the shades still darken along it -- so the ramp survives being seen by
 * somebody who cannot tell the red end from the green one, and does not depend
 * on that for its first reading.
 *
 * `ink` is chosen here rather than left to the calendar. A month chip takes
 * its text colour from Mantine's variant resolver, and at the dark end of this
 * ramp that comes back close enough to the background to be unreadable --
 * `green.9` on `green.9`, which is a label everywhere except on screen. Picked
 * against the six swatches rather than computed, because there are six of them
 * and they do not change. (`teal.6` was given white once, which is 2.4:1 against
 * it; black is better than 8:1. Axe found it the first time the results drew a
 * number on one.)
 */
export const RATINGS = [
  { value: '0', label: '0', color: 'gray.5', ink: 'black' },
  { value: '1', label: '1', color: 'red.4', ink: 'black' },
  { value: '2', label: '2', color: 'orange.5', ink: 'black' },
  { value: '3', label: '3', color: 'yellow.5', ink: 'black' },
  { value: '4', label: '4', color: 'teal.6', ink: 'black' },
  { value: '5', label: '5', color: 'green.9', ink: 'white' },
]

/**
 * The text colour on a chip of this rating. An average is drawn in the colour
 * of the whole rating nearest it, so it is rounded here rather than at every
 * caller.
 */
export function inkFor(rating: number): string {
  return `var(--mantine-color-${RATINGS[Math.round(rating)]?.ink ?? 'black'})`
}

/** The colour a cell of this rating is painted in, rounded as `inkFor` is. */
export function colorFor(rating: number): string {
  return RATINGS[Math.round(rating)]?.color ?? 'gray.5'
}

/** A rating's swatch as a CSS colour, for drawing one outside the calendar. */
export function swatchFor(rating: number): string {
  return rating === 0
    ? 'var(--mantine-color-default-border)'
    : `var(--mantine-color-${colorFor(rating).replace('.', '-')})`
}

/**
 * A colour for a rating that need not be whole -- an average over several
 * ballots -- blended between the two ratings either side of it.
 *
 * The results' averaged calendar says how good a time is by colour alone: a
 * number on every block was the exact answer and a page of digits nobody
 * reads, where a block a little greener than its neighbour is read at a
 * glance. So a 3.4 is mixed four tenths of the way from the 3's yellow to the
 * 4's teal, in plain sRGB, between the same six swatches the ballot paints
 * with -- the ramp is the ballot's, and a whole-number average lands exactly
 * on the colour that rating is painted in.
 *
 * Hex in, hex out, because the calendar takes a CSS colour and Mantine's
 * palette is hex. `palette` is the theme's colours, passed in rather than
 * imported so that a theme which retunes a shade retunes this with it.
 */
export function blendFor(palette: Record<string, readonly string[]>, rating: number): string {
  const clamped = Math.max(0, Math.min(RATINGS.length - 1, rating))
  const low = Math.floor(clamped)
  const high = Math.min(RATINGS.length - 1, low + 1)
  const from = hexToRgb(swatchHex(palette, low))
  const to = hexToRgb(swatchHex(palette, high))
  const t = clamped - low
  return rgbToHex(from.map((channel, i) => channel + (to[i] - channel) * t))
}

/**
 * Black or white, whichever reads better on a blended colour -- the `ink` the
 * six swatches have picked by hand, worked out for the colours between them.
 */
export function inkOn(hex: string): string {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // Contrast against white is 1.05 / (L + 0.05) and against black is
  // (L + 0.05) / 0.05; they are equal at L ≈ 0.179.
  return luminance > 0.179 ? 'var(--mantine-color-black)' : 'var(--mantine-color-white)'
}

function swatchHex(palette: Record<string, readonly string[]>, rating: number): string {
  const [name, shade] = RATINGS[rating].color.split('.')
  return palette[name]?.[Number(shade)] ?? '#adb5bd'
}

function hexToRgb(hex: string): number[] {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16))
}

function rgbToHex(rgb: number[]): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}
