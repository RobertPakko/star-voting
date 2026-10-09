import { test, expect, expectAccessible } from './fixtures'
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
  await page.goto('#/polls/sample-dinner')
  await expect(heading(page)).toHaveText('Movie night')
  await expect(page).toHaveTitle('Movie night')
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()

  await page.getByLabel('Your name').fill('Sam')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()

  // A first ballot carries the voter on to the next question by itself, and
  // a screen reader is told where they have been taken.
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/polls\/sample-movie$/)
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
  await expect(page).toHaveURL(/#\/polls\/sample-result-dinner$/)
  await expect(page.getByText(/^Winner: /)).toBeVisible()
})

test('a vote can be changed before the results are out', async ({ page }) => {
  await page.goto('#/polls/sample-movie')
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
  await page.goto('#/polls/sample-dinner')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/polls\/sample-dinner$/)
})

test('the questions can be walked with the strip', async ({ page }) => {
  await page.goto('#/polls/sample-dinner')
  await page.getByRole('link', { name: 'Next →' }).click()
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await expect(politeAnnouncement(page)).toHaveText('Question 2 of 3: What are we watching?')
  await page.getByRole('link', { name: '← Previous' }).click()
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()
  // The poll is the page, whichever question is open.
  await expect(page).toHaveTitle('Movie night')
})

test('the results show the rounds, the tie-break and the full ranking', async ({ page }) => {
  await page.goto('#/polls/sample-result-dinner')
  await expect(page.getByText('Winner: Two big pizzas')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Scoring' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runoff' })).toBeVisible()
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

test('a tie-break can be opened over its round', async ({ page }) => {
  // The second question is the one the sample records as needing one.
  await page.goto('#/polls/sample-result-movie')
  const show = page.getByRole('button', { name: /Show tie-break/ }).first()
  await show.click()
  await expect(page.getByText(/First rule/).first()).toBeVisible()
  await expectAccessible(page, 'an open tie-break')
})

test('a mistyped sample link says so', async ({ page }) => {
  await page.goto('#/polls/sample-nothing-here')
  await expect(heading(page)).toHaveText('Poll not found')
  await expect(page).toHaveTitle('Poll not found')
})
