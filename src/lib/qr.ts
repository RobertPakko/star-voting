import { encode } from 'uqr'

/**
 * A share link as a QR code, for handing a poll to a room of people who are
 * holding phones and not a keyboard.
 *
 * Two things are fixed here rather than left to the caller, because getting
 * either wrong produces a code that looks right and scans badly:
 *
 * - **Error correction M.** The default L saves a few modules and gives up
 *   the tolerance that makes a code survive being printed, taped to a wall
 *   and photographed at an angle in bad light. M recovers 15% and is the
 *   usual choice for a code that leaves the screen.
 * - **A four-module quiet zone.** The margin is part of the symbol, not
 *   padding: scanners use it to find the code's edge. uqr defaults to one
 *   module, which is below spec.
 */
const QUIET_ZONE = 4

export interface QrCode {
  /** Width and height in modules, quiet zone included. */
  size: number
  /** `modules[y][x]` — true is a dark module. */
  modules: boolean[][]
}

export function qrCodeFor(text: string): QrCode {
  const { size, data } = encode(text, { ecc: 'M', border: QUIET_ZONE })
  return { size, modules: data }
}

/**
 * The dark modules as one SVG path, in a coordinate space one unit per
 * module — so the caller sizes the code with the viewBox and it stays crisp
 * at any size, on screen or printed.
 */
export function qrPath(code: QrCode): string {
  let d = ''
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) d += `M${x},${y}h1v1h-1z`
    }
  }
  return d
}

/**
 * The same code as a PNG data URL, for saving and sending on.
 *
 * Deliberately not a scaled screenshot of the SVG: modules are drawn at a
 * whole number of pixels each, so no edge lands on a half pixel and gets
 * anti-aliased into grey. A blurred module boundary is the one thing that
 * reliably breaks a scan.
 *
 * Returns null only if the browser refuses a 2D canvas, which nothing in the
 * app can do anything useful about beyond leaving the download out.
 */
export function qrPngDataUrl(code: QrCode, targetPx = 1024): string | null {
  const scale = Math.max(1, Math.round(targetPx / code.size))
  const side = code.size * scale

  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Always black on white, whatever the app's colour scheme. A QR code needs
  // dark-on-light to scan, and the file outlives the page it was made on.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, side, side)
  ctx.fillStyle = '#000000'
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) ctx.fillRect(x * scale, y * scale, scale, scale)
    }
  }

  return canvas.toDataURL('image/png')
}

/** A poll title reduced to something safe to hand a filesystem. */
export function qrFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'poll'}-qr.png`
}
