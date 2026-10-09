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
import { ErrorBoundary } from './components/ErrorBoundary'
import { Announcer } from './components/Announcer'
import { registerServiceWorker } from './lib/serviceWorker'
import { reloadOnStaleBuild } from './lib/staleBuild'
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
  // **Colour contrast, which axe checks on every page in `e2e/`.** Three of
  // Mantine's defaults fall short of the 4.5:1 WCAG asks of ordinary text, and
  // each is fixed here once rather than at the call sites that use it:
  //
  //  - A filled control is drawn in shade 8 in both schemes, where the light
  //    scheme used shade 6: white on `blue.6` is 3.55:1, on `blue.8` it is 5.
  //    That is also what puts the primary colour's links at 5:1 on white.
  //  - `autoContrast` picks black or white text for a filled control from its
  //    background. The threshold is where the two give the same contrast, so
  //    whichever is picked is the better of them: a filled orange badge was
  //    white text at 2.57:1 and is now black at 8.
  //  - The dimmed grey, and the text colour of the light badges, are in
  //    `cssVariablesResolver` below.
  primaryShade: { light: 8, dark: 8 },
  autoContrast: true,
  luminanceThreshold: 0.18,
  components: {
    // The label under a control, which is as close to instant as anything in
    // the app gets: it is answering a question the pointer is asking now.
    Tooltip: { defaultProps: { transitionProps: { transition: 'fade', duration: 120 } } },
    Menu: { defaultProps: { transitionProps: { transition: 'pop', duration: 200 } } },
    Popover: { defaultProps: { transitionProps: { transition: 'pop', duration: 200 } } },
    // Every one of these is a creator being asked whether they mean it — see
    // CreatorControls — so it arrives at the same speed as everything else
    // rather than sliding in like something being announced.
    //
    // Two repairs ride along. The close button is an icon with no name, so a
    // screen reader said "button" and nothing more; and the dialog's title
    // bar is a `<header>`, which inside a dialog reads as a second banner for
    // the whole page beside the app's own. It is only a row holding a title
    // and a button, so it is given no role at all.
    Modal: {
      defaultProps: {
        transitionProps: { transition: 'pop', duration: 200 },
        closeButtonProps: { 'aria-label': 'Close' },
        attributes: { header: { role: 'none' } },
      },
    },
    // A toast's close button is an icon with no name of its own, so a screen
    // reader announced it as "button" and nothing more.
    Notification: { defaultProps: { closeButtonProps: { 'aria-label': 'Dismiss' } } },
  },
})

/**
 * The two colours Mantine draws from a variable rather than from the theme,
 * moved to where they pass 4.5:1.
 *
 * **Dimmed text** is the app's secondary line — captions, counts, the
 * sentence beside a button — and Mantine's is 3.3:1 on white and 3.5:1 on a
 * dark card. These are the lightest greys that clear 4.5 on every surface the
 * app puts dimmed text on, the dark card (`dark.6`) included.
 *
 * **A light badge's or button's text** is its colour's shade 9, on its shade 1
 * at rest and shade 2 under the pointer, which for most of the palette is not
 * enough: the green badges were 3.8:1, a subtle blue button 4.0 while hovered,
 * the yellow 2.5. Each is shade 9 taken towards black just far enough to clear
 * 4.6 on the hover shade, so it reads as the same colour as before, a step
 * deeper. The dark scheme's already pass and are left alone.
 */
const resolveCssVariables = () => ({
  variables: {},
  light: {
    '--mantine-color-dimmed': '#666d75',
    '--mantine-color-red-light-color': '#ad2424',
    '--mantine-color-violet-light-color': '#5939b8',
    '--mantine-color-indigo-light-color': '#3249b7',
    '--mantine-color-blue-light-color': '#165a9a',
    '--mantine-color-cyan-light-color': '#0a697a',
    '--mantine-color-teal-light-color': '#077050',
    '--mantine-color-green-light-color': '#237133',
    '--mantine-color-lime-light-color': '#48730a',
    '--mantine-color-yellow-light-color': '#a15300',
    '--mantine-color-orange-light-color': '#ae3a0c',
  },
  dark: {
    '--mantine-color-dimmed': '#a3a3a3',
  },
})

// Before the first render rather than after it, because the render is itself
// a thing that can ask for a chunk the last deploy took away.
reloadOnStaleBuild()
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      defaultColorScheme="auto"
      cssVariablesResolver={resolveCssVariables}
    >
      {/* Inside the provider, so the card it falls back to is themed, and
          outside everything else, so there is nothing left in the app that
          can throw where this would not catch it. */}
      <ErrorBoundary>
        <ThemeColorMeta />
        <Announcer />
        <Notifications />
        <HashRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </HashRouter>
      </ErrorBoundary>
    </MantineProvider>
  </StrictMode>,
)
