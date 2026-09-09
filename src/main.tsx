import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { createTheme, MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './index.css'
import { AuthProvider } from './lib/AuthProvider'
import { ThemeColorMeta } from './components/ThemeColorMeta'
import { registerServiceWorker } from './lib/serviceWorker'
import App from './App.tsx'

/**
 * What Mantine's own moving parts do, decided once for all of them.
 *
 * Every menu, popover, tooltip and modal in the app took Mantine's default
 * transition, which is not the same default for each of them — so the four
 * things in the app that open over the page opened four slightly different
 * ways, for no reason anybody chose. They are set here rather than at the
 * dozen call sites for the reason the badge colours are set in one file: a
 * decision made at the call site is a decision made again every time, and
 * they drift apart in the places nobody looks.
 *
 * **The durations are the same three lengths the rest of the app moves in**,
 * written out as numbers because a transition duration reaches Mantine as one
 * — this is the one place in the app that cannot read `--motion-fast` and its
 * two siblings out of the stylesheet that declares them. They have to be kept
 * in step with `:root` in index.css by hand; there are three of them and they
 * have not changed since they were picked.
 *
 * `respectReducedMotion` is the other half of the rule index.css states over
 * the app's own animations: a reader who has asked their system for less
 * motion gets none from Mantine either. It is off by default in Mantine, so
 * this line is the whole of it.
 */
const theme = createTheme({
  respectReducedMotion: true,
  components: {
    // The label under a control, which is as close to instant as anything in
    // the app gets: it is answering a question the pointer is asking now.
    Tooltip: { defaultProps: { transitionProps: { transition: 'fade', duration: 120 } } },
    Menu: { defaultProps: { transitionProps: { transition: 'pop', duration: 200 } } },
    Popover: { defaultProps: { transitionProps: { transition: 'pop', duration: 200 } } },
    // Every one of these is a creator being asked whether they mean it — see
    // CreatorControls — so it arrives at the same speed as everything else
    // rather than sliding in like something being announced.
    Modal: { defaultProps: { transitionProps: { transition: 'pop', duration: 200 } } },
  },
})

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <ThemeColorMeta />
      <Notifications />
      <HashRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </HashRouter>
    </MantineProvider>
  </StrictMode>,
)
