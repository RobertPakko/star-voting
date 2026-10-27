// What the intro recording's scripts share: the capture browser, calls made
// as the signed-in test account (through its own session, from inside the
// page), and calls made as a stranger holding the link (the anon key, which
// is public). The strangers are what fills the poll on camera.
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
export const URL = env.VITE_SUPABASE_URL
const KEY = env.VITE_SUPABASE_ANON_KEY
export const SITE = 'https://choicelab.app/'

/** The capture browser, started by browser.mjs, and its first tab. */
export async function attach() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? (await context.newPage())
  return { browser, context, page }
}

/** The signed-in account's access token, read from the app's own storage. */
export async function tokenOf(page) {
  if (!page.url().startsWith(SITE)) await page.goto(SITE)
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k))
    return key ? JSON.parse(localStorage.getItem(key)).access_token : null
  })
  if (!token) throw new Error('The capture browser is not signed in')
  return token
}

async function call(fn, args, token) {
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      authorization: `Bearer ${token ?? KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

/** A call as the account. */
export const asMe = (token) => (fn, args) => call(fn, args, token)

/** A stranger with the link: their own voter key, and a name. */
export function stranger(name) {
  const key = randomUUID()
  return {
    name,
    group: (pollId) => call('open_poll_group', { p_poll_id: pollId }),
    view: (pollId) => call('open_poll_view', { p_poll_id: pollId, p_voter_key: key }),
    suggest: (pollId, options) =>
      call('open_poll_suggest_options', { p_poll_id: pollId, p_options: options }),
    confirm: (pollId) =>
      call('open_poll_confirm_options', {
        p_poll_id: pollId,
        p_voter_key: key,
        p_voter_name: name,
      }),
    /** Scores by option name (a map, or a function of the name); anything unnamed is 0. */
    vote: async (pollId, byName) => {
      const view = await call('open_poll_view', { p_poll_id: pollId })
      const score = typeof byName === 'function' ? byName : (n) => byName[n] ?? 0
      const scores = view.options.map((o) => ({ candidate_id: o.id, score: score(o.name) }))
      return call('open_poll_submit', {
        p_poll_id: pollId,
        p_scores: scores,
        p_voter_key: key,
        p_voter_name: name,
      })
    },
  }
}

export const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/** Deletes a poll made on camera, every question of it, as the account. */
export async function deleteGroup(token, groupId) {
  const res = await fetch(`${URL}/rest/v1/polls?group_id=eq.${groupId}`, {
    method: 'DELETE',
    headers: { apikey: KEY, authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`delete: ${res.status} ${await res.text()}`)
}

/** Deletes every poll of the account's with this title. */
export async function deleteTitled(token, title) {
  const res = await fetch(`${URL}/rest/v1/polls?title=eq.${encodeURIComponent(title)}`, {
    method: 'DELETE',
    headers: { apikey: KEY, authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`delete: ${res.status} ${await res.text()}`)
}
