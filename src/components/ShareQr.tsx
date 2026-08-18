import { useMemo } from 'react'
import { Button, Modal, Stack, Text } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { qrCodeFor, qrFileName, qrPath, qrPngDataUrl } from '../lib/qr'

/**
 * The share link as a QR code, so a poll can be handed to a room by holding
 * up a screen instead of reading a token out or asking for phone numbers.
 *
 * It encodes exactly the link `ShareLink` shows, and grants exactly what
 * that link grants — on an open poll the code *is* the capability, and
 * pointing a projector at it puts the poll in front of everyone who can see
 * the screen. The caption says so rather than leaving it to be worked out.
 *
 * Rendered behind a button rather than inline: most polls are shared by
 * pasting a link, and a code big enough to scan is far too big to sit in the
 * manage block unasked.
 */
export function ShareQr({ url, title, isOpen }: { url: string; title: string; isOpen: boolean }) {
  const [opened, modal] = useDisclosure(false)

  // Encoding is cheap but not free, and the modal re-renders on every
  // Mantine transition frame while it opens.
  const code = useMemo(() => qrCodeFor(url), [url])
  const path = useMemo(() => qrPath(code), [code])

  function download() {
    const href = qrPngDataUrl(code)
    if (!href) return
    const link = document.createElement('a')
    link.href = href
    link.download = qrFileName(title)
    link.click()
  }

  return (
    <>
      <Button variant="light" onClick={modal.open}>
        QR code
      </Button>

      <Modal opened={opened} onClose={modal.close} title="Scan to open this poll" centered>
        <Stack gap="md" align="center">
          {/* White plate, always, in both colour schemes: a QR code has to be
              dark-on-light to scan, and inverting one in dark mode is a
              reliable way to produce a code that no phone will read. The
              quiet zone is inside the symbol, so the plate only needs enough
              padding to stop the border cutting into it. */}
          <div
            style={{
              background: '#ffffff',
              padding: 12,
              borderRadius: 8,
              lineHeight: 0,
              width: '100%',
              maxWidth: 320,
            }}
          >
            <svg
              viewBox={`0 0 ${code.size} ${code.size}`}
              width="100%"
              role="img"
              aria-label={`QR code linking to ${title}`}
              shapeRendering="crispEdges"
            >
              <path d={path} fill="#000000" />
            </svg>
          </div>

          <Text size="xs" c="dimmed" ta="center" style={{ wordBreak: 'break-all' }}>
            {url}
          </Text>

          <Text size="xs" c="dimmed" ta="center">
            {isOpen
              ? 'Anyone who can see this code can vote, without signing in — so only show it to the people you want voting.'
              : 'Scanning opens the poll. Only invited people can vote; anyone else will be asked to sign in and then told the poll is unavailable.'}
          </Text>

          <Button variant="light" onClick={download}>
            Download PNG
          </Button>
        </Stack>
      </Modal>
    </>
  )
}
