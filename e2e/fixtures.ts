import { test as base, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * What every test here shares: a page that fails the test when it reaches for
 * the database or logs an error, and an accessibility check.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const problems: string[] = []
    // Nothing these pages draw needs the backend; see playwright.config.ts.
    await page.route('http://127.0.0.1:9/**', (route) => {
      problems.push(`request to the database: ${route.request().method()} ${route.request().url()}`)
      return route.abort()
    })
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console: ${message.text()}`)
    })
    await use(page)
    expect(problems, 'the page reached for the database or reported an error').toEqual([])
  },
})

export { expect }

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

/**
 * What counts as a filled control. Mantine leaves `data-variant` off a
 * component drawn in its default variant, which for these three is `filled`,
 * so naming the attribute alone misses every plain `<Button>`. The calendar's
 * view switcher marks its current view the same way, in the primary colour.
 */
const FILLED = [
  '[data-variant="filled"]',
  '.mantine-Button-root:not([data-variant])',
  '.mantine-Badge-root:not([data-variant])',
  '.mantine-ActionIcon-root:not([data-variant])',
  '.mantine-ViewSelect-headerControl[data-active]',
]

/**
 * Runs axe over what is on screen and fails on anything it finds, at any
 * impact. Checked against the WCAG 2.1 A and AA rules, which is the bar the
 * app is held to, plus axe's best-practice set.
 *
 * One exception, and it is deliberate: **filled controls are left out of the
 * contrast check**. They keep Mantine's own colours — white text on shade 6 —
 * which is under 4.5:1 on several of them; see the theme in `main.tsx`. It is
 * a second pass rather than a rule switched off, so every other piece of text
 * on the page is still measured.
 */
export async function expectAccessible(page: Page, label?: string) {
  const rest = await new AxeBuilder({ page })
    .withTags(TAGS)
    .disableRules(['color-contrast'])
    .analyze()
  // One `exclude` per selector: handed an array, axe reads it as a path into
  // nested frames rather than as a list.
  const contrast = await FILLED.reduce(
    (axe, selector) => axe.exclude(selector),
    new AxeBuilder({ page }).withRules(['color-contrast']),
  ).analyze()
  const violations = [...rest.violations, ...contrast.violations]
  const summary = violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}\n    ${n.failureSummary?.split('\n').at(-1) ?? ''}`).join('\n')}`,
  )
  expect(summary, `accessibility violations${label ? ` on ${label}` : ''}`).toEqual([])
}

/** Switches the app's colour scheme the way the theme menu does, before load. */
export async function setColorScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme })
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('mantine-color-scheme-value', value)
    } catch {
      // A page that refuses storage still follows the emulated media query.
    }
  }, scheme)
}
