/**
 * Web Push, in nothing but WebCrypto.
 *
 * Two standards and nothing else: the payload is encrypted to the browser's
 * key (RFC 8291, which is RFC 8188's `aes128gcm` with the key agreed by ECDH),
 * and the request is signed with the application server's key so the push
 * service knows who is sending (VAPID, RFC 8292). Every browser's push service
 * speaks exactly this, Apple's included, so there is no vendor SDK in here.
 *
 * Written against `crypto.subtle` rather than the `web-push` npm package
 * because that package is Node's `crypto` module underneath, and this runs on
 * Deno in a Supabase Edge Function. WebCrypto is the same API in both — which
 * is also what lets `webpush.test.ts` run this file under vitest in Node and
 * check it against an independent implementation built on `node:crypto`.
 *
 * Pure: no environment, no network except the one `fetch` in `sendPush`.
 */

export type PushTarget = { endpoint: string; p256dh: string; auth: string }

export type Vapid = {
  /** The application server's public key, base64url, uncompressed (65 bytes). */
  publicKey: string
  /** Its private scalar, base64url (32 bytes) — the format `web-push` prints. */
  privateKey: string
  /** A `mailto:` or `https:` contact the push services can reach. */
  subject: string
}

/**
 * The push services this app sends to, which is every service a browser that
 * can subscribe hands out an endpoint on. The database refuses any other
 * endpoint on the way in (`push_subscription_valid`); this is the same list
 * again at the one place a request is actually made, so an endpoint can never
 * turn the sender into a way to POST at an arbitrary address.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
]

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) return false
  const host = url.hostname.toLowerCase()
  return PUSH_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const text = new TextEncoder()

/** HKDF-SHA-256, extract and expand in one: the only way WebCrypto offers it. */
async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Record size. One record holds the whole message — a notification here is a
 * title and a sentence, a hundred-odd bytes against a limit of about four
 * thousand — so this is simply the largest the push services all accept.
 */
const RECORD_SIZE = 4096

/**
 * Encrypts one payload to one browser, as an `aes128gcm` body (RFC 8291 §3).
 *
 * `salt` and `serverKeys` are fresh for every message and are parameters only
 * so a test can fix them; nothing in the sender passes either.
 */
export async function encryptPayload(
  payload: Uint8Array,
  p256dh: string,
  auth: string,
  fixed: { salt?: Uint8Array<ArrayBuffer>; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const receiverPublic = base64urlDecode(p256dh)
  const authSecret = base64urlDecode(auth)
  if (receiverPublic.length !== 65 || authSecret.length !== 16) {
    throw new Error('Malformed subscription keys')
  }
  if (payload.length + 1 + 16 > RECORD_SIZE) throw new Error('Payload too large')

  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const serverKeys =
    fixed.serverKeys ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair)
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey))

  const receiverKey = await crypto.subtle.importKey(
    'raw',
    receiverPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: receiverKey },
      serverKeys.privateKey,
      256,
    ),
  )

  // RFC 8291 §3.3–3.4: the auth secret and both public keys go into the input
  // keying material, and RFC 8188 §2.2 derives the content key and nonce from
  // that and the salt.
  const keyInfo = concat(text.encode('WebPush: info\0'), receiverPublic, serverPublic)
  const ikm = await hkdf(authSecret, shared, keyInfo, 32)
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12)

  // One record, so it is the last: the payload, then the 0x02 delimiter that
  // says so, with no padding after it.
  const plaintext = concat(payload, new Uint8Array([2]))
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext),
  )

  // RFC 8188 §2.1: salt, record size, and the key id — which RFC 8291 says is
  // the application server's public key.
  const header = new Uint8Array(16 + 4 + 1 + serverPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = serverPublic.length
  header.set(serverPublic, 21)

  return concat(header, ciphertext)
}

/** The VAPID private key as WebCrypto wants it: a JWK built from both halves. */
async function signingKey(vapid: Vapid): Promise<CryptoKey> {
  const publicKey = base64urlDecode(vapid.publicKey)
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('Malformed VAPID public key')
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: vapid.privateKey,
      x: base64urlEncode(publicKey.slice(1, 33)),
      y: base64urlEncode(publicKey.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

/**
 * The `Authorization` header for one push service (RFC 8292 §2–3).
 *
 * The audience is the endpoint's origin, so one token serves every endpoint
 * on the same service. WebCrypto's ECDSA signature is already the raw
 * `r || s` that a JWS wants, which is the one thing Node's DER-encoded
 * signatures would have made awkward.
 */
export async function vapidAuthorization(
  endpoint: string,
  vapid: Vapid,
  now: number = Date.now(),
): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' }
  const claims = {
    aud: new URL(endpoint).origin,
    // Twelve hours: the specification caps it at a day, and a token is made
    // per send run, so there is no reason to go near the cap.
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  }
  const unsigned = `${base64urlEncode(text.encode(JSON.stringify(header)))}.${base64urlEncode(
    text.encode(JSON.stringify(claims)),
  )}`
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      await signingKey(vapid),
      text.encode(unsigned),
    ),
  )
  return `vapid t=${unsigned}.${base64urlEncode(signature)}, k=${vapid.publicKey}`
}

export type SendOptions = {
  /** How long the push service should hold the message for an offline device. */
  ttlSeconds: number
  /**
   * A label under which a newer message replaces an undelivered older one
   * (RFC 8030 §5.4): at most 32 base64url characters.
   */
  topic?: string
}

/**
 * Sends one encrypted message to one browser and says what the push service
 * answered. 201 is delivered (or queued); 404 and 410 mean the subscription is
 * gone for good and should be forgotten; anything else is a failure worth
 * reporting and not worth retrying from here.
 */
export async function sendPush(
  target: PushTarget,
  payload: string,
  vapid: Vapid,
  options: SendOptions,
): Promise<number> {
  if (!isPushEndpoint(target.endpoint)) throw new Error('Not a push service endpoint')

  const body = await encryptPayload(text.encode(payload), target.p256dh, target.auth)
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(target.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttlSeconds),
    Urgency: 'normal',
  }
  if (options.topic && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers.Topic = options.topic

  const response = await fetch(target.endpoint, { method: 'POST', headers, body })
  // The body is never needed, and an unread one holds the connection open.
  await response.body?.cancel()
  return response.status
}
