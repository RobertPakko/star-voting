import { test, expect, expectAccessible, setColorScheme } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The About page's sample poll, walked through the way a voter walks through a
 * real one: the same `PublicPoll`, the same ballots, the same results cards,
 * answered from a file rather than the database (see "The About page and its
 * sample poll" in AGENTS.md). Which makes it the one route through the whole
 * of voting that needs no backend, and what these tests use to say voting
 * still works.
 */

/** Scores every option on the ballot on screen, highest first. */
async function scoreAll(page: Page) {
  const groups = page.getByRole('radiogroup', { name: /^Score for / })
  // `count()` does not wait, and the sample's answer arrives a moment after
  // the page does; the first row being there is what says the ballot is.
  await expect(groups.first()).toBeVisible()
  const count = await groups.count()
  expect(count).toBeGreaterThan(1)
  for (let i = 0; i < count; i++) {
    const stars = Math.max(1, 5 - i)
    await groups
      .nth(i)
      .getByRole('radio', { name: `${stars} ${stars === 1 ? 'star' : 'stars'}`, exact: true })
      .click()
  }
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 })
const politeAnnouncement = (page: Page) => page.locator('[data-announcer="polite"]')

test('a voter can answer all three questions and is taken to the result', async ({ page }) => {
  await page.goto('#/sample-dinner')
  await expect(heading(page)).toHaveText('Movie night')
  await expect(page).toHaveTitle('Movie night')
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()

  await page.getByLabel('Your name').fill('Sam')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()

  // A first ballot carries the voter on to the next question by itself, and
  // a screen reader is told where they have been taken.
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/sample-movie$/)
  await expect(politeAnnouncement(page)).toHaveText(/^Question 2 of 3: /)
  // The name typed once is offered again rather than asked for twice.
  await expect(page.getByLabel('Your name')).toHaveValue('Sam')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()

  // The calendar. Untouched is a real answer — every time a 0 — so the ballot
  // goes in as it stands; filling one day is enough to show the brush works.
  await expect(page.getByText('Question 3 of 3', { exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: /Fill the whole day/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Submit vote' }).click()

  // The sample's last ballot leads to the same poll after it was decided.
  await expect(page).toHaveURL(/#\/sample-result-dinner$/)
  await expect(page.getByText(/^Winner: /)).toBeVisible()
})

test('a vote can be changed before the results are out', async ({ page }) => {
  await page.goto('#/sample-movie')
  await page.getByLabel('Your name').fill('Sam')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()
  // Not the last question, so on to the next one owed; back to this one.
  await expect(page.getByText('Question 3 of 3', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: /What are we watching/ }).click()

  await expect(page.getByText('Your vote is in')).toBeVisible()
  await page.getByRole('button', { name: 'Edit vote' }).click()
  const first = page.getByRole('radiogroup', { name: /^Score for / }).first()
  await first.getByRole('radio', { name: '2 stars', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Your vote is in')).toBeVisible()
  // A revision does not move anybody on.
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await expectAccessible(page, 'the card after voting')
})

test('the ballot asks for a name before it is sent', async ({ page }) => {
  await page.goto('#/sample-dinner')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/sample-dinner$/)
})

test('the questions can be walked with the strip', async ({ page }) => {
  await page.goto('#/sample-dinner')
  await page.getByRole('link', { name: 'Next →' }).click()
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await expect(politeAnnouncement(page)).toHaveText('Question 2 of 3: What are we watching?')
  await page.getByRole('link', { name: '← Previous' }).click()
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()
  // The poll is the page, whichever question is open.
  await expect(page).toHaveTitle('Movie night')
})

test('a ballot left half done is there to come back to', async ({ page }) => {
  await page.goto('#/sample-dinner')
  const first = page.getByRole('radiogroup', { name: /^Score for / }).first()
  const fourStars = first.getByRole('radio', { name: '4 stars', exact: true })
  await fourStars.click()
  await expect(fourStars).toBeChecked()

  // Walking to another question unmounts this ballot; its scores come back
  // with it rather than going with it. See lib/ballotDraft.ts.
  await page.getByRole('link', { name: 'Next →' }).click()
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '← Previous' }).click()
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()
  await expect(fourStars).toBeChecked()
})

test('a name typed and not yet sent survives a refresh', async ({ page }) => {
  await page.goto('#/sample-dinner')
  await page.getByLabel('Your name').fill('Sam')
  await page.reload()
  await expect(page.getByLabel('Your name')).toHaveValue('Sam')

  // An emptied box forgets the name rather than leaving part of it behind.
  await page.getByLabel('Your name').fill('')
  await page.reload()
  await expect(page.getByLabel('Your name')).toHaveValue('')
})

test('the results show the rounds, the tie-break and the full ranking', async ({ page }) => {
  await page.goto('#/sample-result-dinner')
  await expect(page.getByText('Winner: Two big pizzas')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Scoring' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runoff' })).toBeVisible()
  // The runoff elected the winner, so it is read first, straight under it.
  const rounds = page.getByRole('heading', { name: /^(Runoff|Scoring)$/ })
  await expect(rounds).toHaveText(['Runoff', 'Scoring'])
  await expect(page.getByRole('heading', { name: 'Ballots' })).toBeVisible()

  await page.getByRole('button', { name: 'See the full ranking' }).click()
  const ranking = page.getByRole('dialog', { name: 'Full ranking' })
  await expect(ranking).toBeVisible()
  // Every option placed, the last included: the ranking is the whole field.
  for (const option of ['Two big pizzas', 'Taco bar', 'Thai delivery', 'Just snacks'])
    await expect(ranking).toContainText(option)
  await expectAccessible(page, 'the full ranking')
  await page.keyboard.press('Escape')
  await expect(ranking).toBeHidden()
})

test('a finished poll goes from one skeleton straight to its results', async ({ page }) => {
  // Every frame from the first, which is the only way to see a wait that
  // lasts one: the page used to arrive and then fill its tally in behind a
  // second skeleton of a different shape, while that card's code was fetched
  // and again while the card took the tally it had been handed.
  await page.addInitScript(() => {
    const shapes: number[] = []
    Object.assign(window, { skeletonShapes: shapes })
    const frame = () => {
      const count = document.querySelectorAll('.mantine-Skeleton-root').length
      if (count !== shapes.at(-1)) shapes.push(count)
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  await page.goto('#/sample-result-dinner')
  await expect(page.getByText('Winner: Two big pizzas')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ballots' })).toBeVisible()
  const shapes = await page.evaluate(
    () => (window as unknown as { skeletonShapes: number[] }).skeletonShapes,
  )
  expect(shapes.filter((count) => count > 0)).toHaveLength(1)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`a calendar poll publishes its ballots as one averaged calendar (${scheme})`, async ({
    page,
  }) => {
    await setColorScheme(page, scheme)
    await page.goto('#/sample-result-when')
    await expect(page.getByRole('heading', { name: 'Ballots' })).toBeVisible()
    // The calendar stands where the table would have, and the download is
    // still beside the heading.
    await expect(page.getByRole('region', { name: 'Ballots' })).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Download these ballots as a CSV' }),
    ).toBeVisible()

    await expect(page.getByRole('combobox', { name: 'Whose ballots to average' })).toBeVisible()
    await expect(page.getByText(/^The average of all \d+ voters\.$/)).toBeVisible()
    await expectAccessible(page, 'the averaged calendar')
    await page.getByRole('tab', { name: 'Switch to month view' }).click()
    await expectAccessible(page, 'the averaged calendar, by the month')

    // Taking everybody out leaves nothing to average, and Everyone puts them back.
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(page.getByText('Nobody picked.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Everyone' }).click()
    await expect(page.getByText(/^The average of all \d+ voters\.$/)).toBeVisible()
  })
}

test('a tie-break can be opened over its round', async ({ page }) => {
  // The second question is the one the sample records as needing one.
  await page.goto('#/sample-result-movie')
  const show = page.getByRole('button', { name: /Show tie-break/ }).first()
  await show.click()
  await expect(page.getByText(/First rule/).first()).toBeVisible()
  await expectAccessible(page, 'an open tie-break')
})

test('a mistyped sample link says so', async ({ page }) => {
  await page.goto('#/sample-nothing-here')
  await expect(heading(page)).toHaveText('Poll not found')
  await expect(page).toHaveTitle('Poll not found')
})

test('a link from before the rebrand still opens its poll', async ({ page }) => {
  // `#/polls/<id>` was every poll's address, and is in every email ever sent.
  await page.goto('#/sample-dinner')
  await expect(page).toHaveURL(/#\/sample-dinner$/)
  await expect(heading(page)).toHaveText('Movie night')
})

test('a one-word address that is not a poll is a missing page', async ({ page }) => {
  await page.goto('#/abuot')
  await expect(heading(page)).toHaveText('Page not found')
})
