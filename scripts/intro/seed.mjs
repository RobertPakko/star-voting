// Puts the example polls on the test account's list, for the intro's last
// shot. Run once; they are left there for later recordings (and are purged
// at six months, after which this is run again). Oldest first, so the poll
// made on camera lands above them.
import { asMe, attach, pause, stranger, tokenOf } from './lib.mjs'

const { page } = await attach()
const me = asMe(await tokenOf(page))
const people = ['Alex', 'Sam', 'Priya', 'Jordan', 'Mei', 'Luis'].map(stranger)

async function poll(title, description, options, extra = {}) {
  const id = await me('create_poll', {
    p_title: title,
    p_description: description,
    p_emails: [],
    p_mode: 'open',
    p_options: options,
    p_show_voters: true,
    p_show_ballots: false,
    ...extra,
  })
  await pause(1100)
  return id
}

/** Each row is one voter's scores, in the order of `options`. */
async function votes(id, options, rows) {
  for (const [i, row] of rows.entries())
    await people[i].vote(id, Object.fromEntries(options.map((o, j) => [o, row[j]])))
}

// Finished, with a winner.
const lunch = ['Pho House', 'Taco truck', 'Sushi bar', 'Pizza place']
const lunchId = await poll('Team lunch spot', 'Friday, after the sprint demo.', lunch)
await votes(lunchId, lunch, [
  [5, 3, 2, 1],
  [4, 5, 1, 2],
  [5, 2, 4, 0],
  [3, 4, 5, 1],
  [5, 1, 3, 2],
])
await me('close_poll', { p_poll_id: lunchId })

// Finished, with a winner.
const games = ['Catan', 'Codenames', 'Wingspan']
const gamesId = await poll('Board game night', null, games)
await votes(gamesId, games, [
  [2, 5, 4],
  [3, 4, 5],
  [1, 5, 3],
  [4, 3, 2],
])
await me('close_poll', { p_poll_id: gamesId })

// Still taking votes.
const books = ['Project Hail Mary', 'Piranesi', 'The Midnight Library', 'Klara and the Sun']
const booksId = await poll(
  'Book club: next pick',
  'We meet the first Thursday of the month.',
  books,
)
await votes(booksId, books, [
  [5, 4, 2, 3],
  [4, 5, 1, 2],
  [3, 3, 4, 5],
])

// Still collecting options.
const partyId = await poll('Holiday party theme', 'Suggest a theme, then we vote.', [], {
  p_solicit_options: true,
})
await people[0].suggest(partyId, [{ name: 'Ugly sweaters', description: null }])
await people[0].confirm(partyId)
await people[1].suggest(partyId, [{ name: 'Casino night', description: null }])
await people[1].confirm(partyId)

console.log('seeded', { lunchId, gamesId, booksId, partyId })
process.exit(0)
