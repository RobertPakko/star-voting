import { test, expect, expectAccessible, setColorScheme } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The sample poll, walked through the way a voter walks through a
 * real one: the same `PublicPoll`, the same ballots, the same results cards,
 * answered from a file rather than the database (see "The sample poll" in
 * AGENTS.md). Which makes it the one route through the whole
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

test('a voter can answer every question and is taken to the result', async ({ page }) => {
  await page.goto('#/sample-movie')
  await expect(heading(page)).toHaveText('Movie night')
  await expect(page).toHaveTitle('Movie night')
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()

  await page.getByLabel('Your name').fill('Sam')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()

  // A first ballot carries the voter on to the next question by itself, and
  // a screen reader is told where they have been taken. The name typed once
  // is offered again rather than asked for twice.
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/sample-snacks$/)
  await expect(politeAnnouncement(page)).toHaveText(/^Question 2 of 3: /)
  await expect(page.getByLabel('Your name')).toHaveValue('Sam')

  // The snacks, scored like the films.
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()
  await expect(page.getByText('Question 3 of 3', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/sample-when$/)

  // The calendar. Untouched is a real answer — every time a 0 — so the ballot
  // goes in as it stands; filling one day is enough to show the brush works.
  await page
    .getByRole('button', { name: /Fill the whole day/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Submit vote' }).click()

  // The sample's last ballot leads to the same poll after it was decided.
  await expect(page).toHaveURL(/#\/sample-result-movie$/)
  await expect(page.getByText(/^Best (option|time): /)).toBeVisible()
})

test('a vote can be changed before the results are out', async ({ page }) => {
  await page.goto('#/sample-movie')
  await page.getByLabel('Your name').fill('Sam')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()
  // Not the last question, so on to the next one owed; back to this one.
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: /What are we watching/ }).click()

  await expect(page.getByText('Your vote is in')).toBeVisible()
  await page.getByRole('button', { name: 'Edit vote' }).click()
  const first = page.getByRole('radiogroup', { name: /^Score for / }).first()
  await first.getByRole('radio', { name: '2 stars', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Your vote is in')).toBeVisible()
  // A revision does not move anybody on.
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()
  await expectAccessible(page, 'the card after voting')
})

test('the ballot asks for a name before it is sent', async ({ page }) => {
  await page.goto('#/sample-movie')
  await scoreAll(page)
  await page.getByRole('button', { name: 'Submit vote' }).click()
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/sample-movie$/)
})

test('the questions can be walked with the strip', async ({ page }) => {
  await page.goto('#/sample-movie')
  await page.getByRole('link', { name: 'Next →' }).click()
  await expect(page.getByText('Question 2 of 3', { exact: true })).toBeVisible()
  await expect(politeAnnouncement(page)).toHaveText('Question 2 of 3: What snack do you want?')
  await page.getByRole('link', { name: '← Previous' }).click()
  await expect(page.getByText('Question 1 of 3', { exact: true })).toBeVisible()
  // The poll is the page, whichever question is open.
  await expect(page).toHaveTitle('Movie night')
})

test('a ballot left half done is there to come back to', async ({ page }) => {
  await page.goto('#/sample-movie')
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
  await page.goto('#/sample-movie')
  await page.getByLabel('Your name').fill('Sam')
  await page.reload()
  await expect(page.getByLabel('Your name')).toHaveValue('Sam')

  // An emptied box forgets the name rather than leaving part of it behind.
  await page.getByLabel('Your name').fill('')
  await page.reload()
  await expect(page.getByLabel('Your name')).toHaveValue('')
})

test('the results show the rounds, the tie-break and the other answers', async ({ page }) => {
  // Six modals and a four-second wheel spin: more than the default budget
  // when the whole suite runs at once.
  test.slow()
  await page.goto('#/sample-result-movie')
  await expect(page.getByText('Best option: Knives Out')).toBeVisible()
  // The bar names what the question asked for, and its info mark says what
  // that is in a sentence, leading to where it is explained.
  await page.getByRole('button', { name: 'What best option means' }).click()
  const blurb = page.getByRole('dialog').filter({ hasText: 'picks one option using STAR' })
  await expect(blurb).toBeVisible()
  await expect(blurb.getByRole('link', { name: 'Learn more' })).toHaveAttribute(
    'href',
    '#/choices?section=best-option',
  )
  await expectAccessible(page, 'the info popover on the result')
  await page.keyboard.press('Escape')
  await expect(blurb).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Scoring' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runoff' })).toBeVisible()
  // The runoff elected the winner, so it is read first, straight under it.
  const rounds = page.getByRole('heading', { name: /^(Runoff|Scoring)$/ })
  await expect(rounds).toHaveText(['Runoff', 'Scoring'])
  await expect(page.getByRole('heading', { name: 'Ballots' })).toBeVisible()

  // The other answers are one menu in the winner's banner.
  const more = page.getByRole('button', { name: 'More results' })
  // Clicked only once the dropdown has finished growing in, since an item
  // still moving never counts as stable to click.
  const openMore = async () => {
    await more.click()
    await page.waitForTimeout(300)
  }
  await openMore()
  // Not run through axe while open: Mantine puts a focusable presentation
  // div of its own at the head of every menu, which axe reads as a menu
  // holding something other than items.
  await expect(page.getByRole('menuitem')).toHaveText([
    'Consensus option',
    'Consensus winners',
    'Multiple winners',
    'Proportional winners',
    'Fractional winners',
  ])
  await page.getByRole('menuitem', { name: 'Multiple winners' }).click()
  const ranking = page.getByRole('dialog', { name: 'Multiple winners' })
  await expect(ranking).toBeVisible()
  // Every option placed, the last included: the ranking is the whole field.
  for (const option of ['Knives Out', 'Paddington 2', 'The Matrix', 'Honeyland'])
    await expect(ranking).toContainText(option)
  // Opened from the menu, it is the whole ranking, with no number to pick.
  await expect(ranking.getByLabel('Number of winners')).toHaveCount(0)
  await expectAccessible(page, 'multiple winners')
  await page.keyboard.press('Escape')
  await expect(ranking).toBeHidden()

  // The others, each the count recorded with nothing removed: the sample
  // offers no removing.
  const answers = {
    // Nobody gave Paddington 2 fewer than 2 stars.
    'Consensus option': 'Paddington 2',
    'Proportional winners': 'Knives Out',
  }
  for (const [name, says] of Object.entries(answers)) {
    await openMore()
    await page.getByRole('menuitem', { name }).click()
    const dialog = page.getByRole('dialog', { name })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(says)
    await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    await page.waitForTimeout(600)
    await expectAccessible(page, `the ${name.toLowerCase()} modal`)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }

  // The evening is split, and the list names only the films given a share:
  // the percentages already account for the whole.
  await openMore()
  await page.getByRole('menuitem', { name: 'Fractional winners' }).click()
  const shares = page.getByRole('dialog', { name: 'Fractional winners' })
  await expect(shares.getByRole('listitem')).toHaveText([
    'Knives Out61%',
    'Paddington 224%',
    'The Matrix15%',
  ])
  await expect(shares.getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await page.waitForTimeout(600)
  await expectAccessible(page, 'the fractional winners modal')

  // The wheel draws one of the films with a share, and says which.
  await shares.getByRole('button', { name: 'Spin the wheel' }).click()
  await expect(shares).toContainText(/The wheel landed on (Knives Out|Paddington 2|The Matrix)\./, {
    timeout: 10_000,
  })
  await expect(shares.getByRole('button', { name: 'Spin again' })).toBeEnabled()
  await expectAccessible(page, 'the fractional winners wheel')
  await page.keyboard.press('Escape')
  await expect(shares).toBeHidden()

  // The Matrix's second spot is a close weighted runoff: written to one
  // decimal place both sides would read 2.5, a tie with no tie-break.
  await openMore()
  await page.getByRole('menuitem', { name: 'Proportional winners' }).click()
  const spots = page.getByRole('dialog', { name: 'Proportional winners' })
  await expect(spots).toContainText('Preferred over Paddington 2 by 2.51 votes to 2.48.')
  await page.keyboard.press('Escape')
  await expect(spots).toBeHidden()
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
  await page.goto('#/sample-result-movie')
  await expect(page.getByText('Best option: Knives Out')).toBeVisible()
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
    // The question asked for the consensus time, which takes the winner's
    // place: not STAR's 9:00, which Chloe can only half make.
    await expect(page.getByText('Consensus time: 10:00am, Sat Feb 21 (4 hours)')).toBeVisible()
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

    // A block opens how each voter rated it, and Escape closes it.
    await page.getByRole('tab', { name: 'Switch to week view' }).click()
    const block = page.getByRole('button', { name: '11am–1pm, Sat Feb 21: average 4.7 of 5' })
    await block.click()
    const breakdown = page.getByRole('dialog', {
      name: '11am–1pm, Sat Feb 21: average 4.7 of 5',
    })
    await expect(breakdown).toBeVisible()
    await expect(breakdown.getByText('Ben', { exact: true })).toBeVisible()
    await expectAccessible(page, 'a block of the averaged calendar, broken down')
    await page.keyboard.press('Escape')
    await expect(breakdown).toHaveCount(0)

    // Taking everybody out leaves nothing to average, and Everyone puts them back.
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(page.getByText('Nobody picked.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Everyone' }).click()
    await expect(page.getByText(/^The average of all \d+ voters\.$/)).toBeVisible()
  })
}

test('a tie-break can be opened over its round', async ({ page }) => {
  // The film question is the one the sample records as needing one.
  await page.goto('#/sample-result-movie')
  const show = page.getByRole('button', { name: /Show tie-break/ }).first()
  await show.click()
  await expect(page.getByText(/First rule/).first()).toBeVisible()
  await expectAccessible(page, 'an open tie-break')
})

test('the sequential example counts each ballot at its weight, and says so on the sheet', async ({
  page,
}) => {
  await page.goto('#/variants?section=sequential-polls')
  await page.getByRole('link', { name: 'See an example' }).click()
  await expect(page).toHaveURL(/#\/sample-result-movie-as-sequential$/)
  // Counted fresh, Knives Out wins; weighed by last month's movie night,
  // its fans count for less and Paddington 2 wins.
  await expect(page.getByText('Best option: Paddington 2')).toBeVisible()
  const sheet = page.getByRole('region', { name: 'Ballots' })
  await expect(sheet.getByRole('columnheader', { name: 'Weight', exact: true })).toBeVisible()
  // Gina gave last month's winners nothing, so she is the strongest ballot;
  // Ana gave them 9, so hers counts at 5 / (5 + 9).
  await expect(sheet.getByRole('row', { name: /^Gina 1 / })).toBeVisible()
  await expect(sheet.getByRole('row', { name: /^Ana 5\/14 / })).toBeVisible()
  await expect(sheet.getByText('Weighted total')).toBeVisible()
  await expectAccessible(page, 'a sequential count and its weighted sheet')
})

test('the budget example shares the money out', async ({ page }) => {
  await page.goto('#/variants?section=budget-polls')
  await page.getByRole('link', { name: 'See an example' }).click()
  await expect(page).toHaveURL(/#\/sample-result-snacks-as-budget$/)
  // The cheap gummy bears go first, then popcorn, chocolate and pretzels.
  await expect(page.getByText('18 of 20 spent, 2 left over.')).toBeVisible()
  await expect(page.getByText('Nachos (8), Ice cream (9)')).toBeVisible()
  // The recording cannot count again, so nothing offers to.
  await expect(page.getByRole('button', { name: 'Edit costs' })).toHaveCount(0)
  await expectAccessible(page, 'a budget poll')
})

test('an assignment gives each friend a snack, as far as each snack goes', async ({ page }) => {
  await page.goto('#/sample-result-snacks')
  await expect(page.getByText('Every voter has an option, in 11 places.')).toBeVisible()
  // Gina and Iris both most want the one tub of ice cream; Iris gets it, and
  // Gina the gummy bears she gave 4.
  await expect(page.getByText('Iris (5)', { exact: true })).toBeVisible()
  await expect(page.getByText('Gina (4), Hugo (5)')).toBeVisible()
  // The recording cannot count again, so nothing offers to.
  await expect(page.getByRole('button', { name: 'Edit places' })).toHaveCount(0)
  await expectAccessible(page, 'an option assignment')
})

test('the sequel’s old links go to the examples that replaced them', async ({ page }) => {
  await page.goto('#/sample-sequel-budget')
  await expect(page).toHaveURL(/#\/sample-result-snacks-as-budget$/)
})

test('consensus winners serve every voter a film they gave 3 or more', async ({ page }) => {
  await page.goto('#/sample-result-movie-as-consensus-winners')
  // Knives Out, The Matrix and Paddington 2 between them leave nobody below
  // 3 stars, where no one film is given more than 2 by everybody.
  await expect(page.getByText('Everyone gave at least one of these 3 stars or more.')).toBeVisible()
  for (const film of ['Knives Out', 'The Matrix', 'Paddington 2'])
    await expect(page.getByText(film, { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Best for 4 voters · 29 stars')).toBeVisible()
  // The recording cannot count again, so nothing offers to.
  await expect(page.getByLabel('Number of winners')).toHaveCount(0)
  await expectAccessible(page, 'consensus winners')
})

test('a mistyped sample link says so', async ({ page }) => {
  await page.goto('#/sample-nothing-here')
  await expect(heading(page)).toHaveText('Poll not found')
  await expect(page).toHaveTitle('Poll not found')
})

test('a one-word address that is not a poll is a missing page', async ({ page }) => {
  await page.goto('#/abuot')
  await expect(heading(page)).toHaveText('Page not found')
})
