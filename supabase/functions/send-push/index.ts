/**
 * The send-push Edge Function: the half of a push notification the database
 * cannot do.
 *
 * Postgres decides everything about a notification — which moment, which
 * poll, the words, and every browser it is for — and hands the lot here in one
 * request from `send_push()`, through pg_net, the same way it hands an email
 * to Resend. What it cannot do is the cryptography: a push has to be encrypted
 * to each browser's key and signed with the app's VAPID key, and pgcrypto has
 * neither ECDH nor ECDSA. So this function is deliberately dumb. It checks the
 * caller, encrypts, sends, and tells the database which browsers the push
 * services said are gone. It reads no tables and makes no decisions.
 *
 * Environment (Supabase → Edge Functions → Secrets):
 *   PUSH_FUNCTION_SECRET  the shared secret the database sends as a bearer
 *                         token; the same value is in Vault as
 *                         `push_function_secret`
 *   VAPID_PUBLIC_KEY      base64url, as `npx web-push generate-vapid-keys`
 *   VAPID_PRIVATE_KEY     prints them; the public half is also the app's
 *                         VITE_VAPID_PUBLIC_KEY
 *   VAPID_SUBJECT         optional, a mailto: the push services can reach
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by Supabase
 *
 * Deployed with JWT verification off (`--no-verify-jwt`): the caller is the
 * database, which holds no user's token, and the shared secret is the check
 * instead. See AGENTS.md, "Push notifications".
 */

import { sendPush, type PushTarget, type Vapid } from './webpush.ts'

type Message = { title: string; body: string; path: string; tag?: string }

/** How long a push service holds a message for a phone that is off: three days. */
const TTL_SECONDS = 3 * 24 * 60 * 60

/** How many requests are in flight at once, so a poll of hundreds is a queue. */
const CONCURRENCY = 20

function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** Compared without an early exit, so the check does not time how much matched. */
function sameSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let difference = left.length ^ right.length
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return difference === 0
}

function isTarget(value: unknown): value is PushTarget {
  const target = value as PushTarget
  return (
    typeof target?.endpoint === 'string' &&
    typeof target.p256dh === 'string' &&
    typeof target.auth === 'string'
  )
}

function isMessage(value: unknown): value is Message {
  const message = value as Message
  return (
    typeof message?.title === 'string' &&
    typeof message.body === 'string' &&
    typeof message.path === 'string'
  )
}

/** Tells the database which browsers are gone, so nothing is sent to them again. */
async function forget(endpoints: string[]) {
  if (endpoints.length === 0) return
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  const response = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/forget_push_endpoints`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_endpoints: endpoints }),
  })
  if (!response.ok) console.error('forget_push_endpoints', response.status, await response.text())
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!sameSecret(token, env('PUSH_FUNCTION_SECRET'))) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: { message?: unknown; targets?: unknown }
  try {
    body = await request.json()
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const { message, targets } = body
  if (!isMessage(message) || !Array.isArray(targets) || !targets.every(isTarget)) {
    return new Response('Bad request', { status: 400 })
  }
  const tag = message.tag

  const vapid: Vapid = {
    publicKey: env('VAPID_PUBLIC_KEY'),
    privateKey: env('VAPID_PRIVATE_KEY'),
    subject: Deno.env.get('VAPID_SUBJECT') || 'mailto:noreply@choicelab.app',
  }
  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    path: message.path,
    tag: message.tag,
  })

  let sent = 0
  let failed = 0
  const gone: string[] = []
  const queue: PushTarget[] = [...targets]

  async function worker() {
    for (let target = queue.shift(); target; target = queue.shift()) {
      try {
        const status = await sendPush(target, payload, vapid, {
          ttlSeconds: TTL_SECONDS,
          topic: tag,
        })
        if (status === 404 || status === 410) gone.push(target.endpoint)
        else if (status >= 200 && status < 300) sent++
        else {
          failed++
          console.error('push service answered', status, new URL(target.endpoint).host)
        }
      } catch (error) {
        failed++
        console.error('push failed', error instanceof Error ? error.message : error)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  await forget(gone)

  return Response.json({ sent, gone: gone.length, failed })
})
