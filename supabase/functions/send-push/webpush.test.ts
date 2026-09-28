import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  base64urlDecode,
  base64urlEncode,
  encryptPayload,
  isPushEndpoint,
  vapidAuthorization,
} from './webpush'

/**
 * The encryption is the one part of a push that fails silently: a payload the
 * browser cannot decrypt is dropped by the browser, the push service still
 * answers 201, and nothing anywhere says a notification was lost. So it is
 * checked here against a second implementation of RFC 8291 written the other
 * way — Node's `crypto` module rather than WebCrypto, the receiving side
 * rather than the sending one — which is what a browser does with it.
 */

/** A browser's side of a subscription: its key pair and its auth secret. */
function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff)
  return {
    ecdh,
    p256dh: base64urlEncode(new Uint8Array(ecdh.getPublicKey())),
    auth: base64urlEncode(auth),
    authBytes: auth,
  }
}

/** RFC 8291 §3 and RFC 8188 §2, as the receiving browser runs them. */
function decrypt(body: Uint8Array, receiver: ReturnType<typeof browser>): string {
  const salt = body.slice(0, 16)
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idLength = body[20]
  const serverPublic = body.slice(21, 21 + idLength)
  const ciphertext = body.slice(21 + idLength)
  expect(recordSize).toBeGreaterThanOrEqual(ciphertext.length)

  const shared = receiver.ecdh.computeSecret(serverPublic)
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    receiver.ecdh.getPublicKey(),
    serverPublic,
  ])
  const ikm = Buffer.from(hkdfSync('sha256', shared, receiver.authBytes, keyInfo, 32))
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  )
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  )

  const tag = ciphertext.slice(ciphertext.length - 16)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(tag)
  const padded = Buffer.concat([
    decipher.update(ciphertext.slice(0, ciphertext.length - 16)),
    decipher.final(),
  ])
  // The last record ends in 0x02 followed by any padding of zeros.
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) end--
  expect(padded[end]).toBe(2)
  return padded.subarray(0, end).toString('utf8')
}

describe('encryptPayload', () => {
  it('produces a body the receiving browser can decrypt', async () => {
    const receiver = browser()
    const message = JSON.stringify({ title: 'Film night', body: 'The results are ready.' })
    const body = await encryptPayload(
      new TextEncoder().encode(message),
      receiver.p256dh,
      receiver.auth,
    )
    expect(decrypt(body, receiver)).toBe(message)
  })

  it('names its own public key in the header, and is fresh every time', async () => {
    const receiver = browser()
    const payload = new TextEncoder().encode('same words')
    const first = await encryptPayload(payload, receiver.p256dh, receiver.auth)
    const second = await encryptPayload(payload, receiver.p256dh, receiver.auth)
    expect(first[20]).toBe(65)
    expect(first[21]).toBe(4)
    expect(base64urlEncode(first)).not.toBe(base64urlEncode(second))
    expect(decrypt(second, receiver)).toBe('same words')
  })

  it('refuses keys of the wrong length', async () => {
    const receiver = browser()
    await expect(
      encryptPayload(new Uint8Array(1), receiver.p256dh.slice(4), receiver.auth),
    ).rejects.toThrow('Malformed subscription keys')
  })
})

describe('vapidAuthorization', () => {
  it('is a JWT for the endpoint origin, signed by the key it names', async () => {
    const server = createECDH('prime256v1')
    server.generateKeys()
    const vapid = {
      publicKey: base64urlEncode(new Uint8Array(server.getPublicKey())),
      privateKey: base64urlEncode(new Uint8Array(server.getPrivateKey())),
      subject: 'mailto:someone@example.com',
    }
    const now = Date.UTC(2026, 8, 28)
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, now)

    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
    expect(match).not.toBeNull()
    const [, head, claims, signature, key] = match!
    expect(key).toBe(vapid.publicKey)
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(head)))).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    })
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(claims)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 60 * 60,
      sub: 'mailto:someone@example.com',
    })

    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: base64urlEncode(base64urlDecode(vapid.publicKey).slice(1, 33)),
        y: base64urlEncode(base64urlDecode(vapid.publicKey).slice(33, 65)),
      },
      format: 'jwk',
    })
    const valid = verify(
      'sha256',
      Buffer.from(`${head}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      base64urlDecode(signature),
    )
    expect(valid).toBe(true)
  })
})

describe('isPushEndpoint', () => {
  it('takes the four push services', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true)
    expect(isPushEndpoint('https://web.push.apple.com/abc')).toBe(true)
    expect(isPushEndpoint('https://wns2-by3p.notify.windows.com/w/?token=abc')).toBe(true)
  })

  it('and nothing that only looks like one', () => {
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false)
    expect(isPushEndpoint('https://fcm.googleapis.com.example.com/abc')).toBe(false)
    expect(isPushEndpoint('https://evilfcm.googleapis.com/abc')).toBe(false)
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/abc')).toBe(false)
    expect(isPushEndpoint('not a url')).toBe(false)
  })
})
