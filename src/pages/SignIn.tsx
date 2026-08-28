import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Anchor,
  Button,
  Center,
  Paper,
  PinInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { useAuth } from '../lib/auth'
import { rememberDestination } from '../lib/shareLink'
import {
  CODE_LENGTH,
  MIN_CODE_LENGTH,
  rememberedSignInMethod,
  rememberSignInMethod,
  type SignInMethod,
} from '../lib/signInMethod'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The whole of the way in, and the choice of two ways in.
 *
 * A link is the default and is easier whenever it works; a code is for the
 * readers it does not work for, and there is no way to tell which those are
 * from here — see lib/signInMethod.ts. The choice is made before the email
 * goes out, because it is what decides which email goes out, and it is
 * remembered so that a reader who needs a code has to say so once.
 *
 * Three states, in one card: the form, then whichever of the two the email
 * that went out was. Only the code state has anything left to do here, which
 * is the point of it — the session it ends in is minted in this window, so
 * nothing about the reader's inbox, its browser, or whether this app is
 * installed can come between them and it.
 *
 * The About link is offered on the form and nowhere else. Somebody waiting on
 * an email has a minute to spare and may well not know what STAR voting is,
 * but this card is not a route and following a link away from it would throw
 * away the address the code they are waiting for belongs to — and Supabase
 * will not send another for a minute.
 */
export function SignIn() {
  const { signInWithEmail, verifySignInCode } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [method, setMethod] = useState<SignInMethod>(rememberedSignInMethod)
  const [sending, setSending] = useState(false)
  // Which email actually went out, and null while none has. Held rather than
  // read back off `method` so the card goes on describing the email in the
  // reader's inbox and not a control they can no longer see.
  const [sent, setSent] = useState<SignInMethod | null>(null)
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    setError(null)
    const trimmed = email.trim().toLowerCase()
    if (!EMAIL_RE.test(trimmed)) {
      setError('Enter a valid email address.')
      return
    }
    setSending(true)
    try {
      // Held for `App` to send the reader on with once there is a session.
      // A link drops the hash route on the way back and has always needed
      // this; a code goes nowhere and keeps the route it was asked from, but
      // the hand-off on the other side is the same one either way, so this
      // is not worth making conditional.
      rememberDestination(location.pathname)
      rememberSignInMethod(method)
      await signInWithEmail(trimmed, method)
      // The address the email actually went to, which is the one to name on
      // the card and the one a code has to be redeemed against. Normalising
      // the field rather than holding a second copy of it also means starting
      // over lands back on the form with it already tidied.
      setEmail(trimmed)
      setCode('')
      setSent(method)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send the sign-in email.')
    } finally {
      setSending(false)
    }
  }

  async function handleVerify(value: string) {
    if (verifying) return
    setError(null)
    setVerifying(true)
    try {
      await verifySignInCode(email, value)
      // Nothing to do on success. The client saves the session and announces
      // it, `AuthProvider` picks it up, and this screen stops being a route.
    } catch {
      // Supabase answers a wrong code and an expired one with the same
      // message, deliberately, and neither is worth passing on verbatim.
      setError('That code did not work. Check it, or start over for a new one.')
    } finally {
      setVerifying(false)
    }
  }

  function startOver() {
    setSent(null)
    setCode('')
    setError(null)
  }

  return (
    <Center h="100vh">
      <Paper withBorder shadow="sm" p="xl" radius="md" w={360}>
        <Stack align="center" gap="md">
          <Title order={2}>STAR Voting</Title>
          {sent === 'code' ? (
            <>
              <Text ta="center">
                Enter the code sent to <strong>{email}</strong>
              </Text>
              <PinInput
                length={CODE_LENGTH}
                type="number"
                // Sized to the card rather than to taste: eight boxes at the
                // default size are wider than the 360px this sits in.
                size="xs"
                gap={6}
                autoFocus
                ariaLabel="Sign-in code"
                value={code}
                error={!!error}
                disabled={verifying}
                onChange={(value) => {
                  setCode(value)
                  setError(null)
                }}
                // A full set of boxes is the whole of the intent, and a phone
                // filling them in from the notification should not then have
                // to be told to go ahead. The button below is for a code that
                // was wrong the first time — and for one shorter than the
                // boxes built for it, which is the mismatch above.
                onComplete={handleVerify}
              />
              {error && (
                <Text c="red" size="sm" ta="center">
                  {error}
                </Text>
              )}
              <Button
                fullWidth
                loading={verifying}
                disabled={code.length < MIN_CODE_LENGTH}
                onClick={() => handleVerify(code)}
              >
                Sign in
              </Button>
              <Anchor component="button" type="button" size="sm" onClick={startOver}>
                Start over
              </Anchor>
            </>
          ) : sent === 'link' ? (
            <>
              <Text ta="center">
                Check <strong>{email}</strong> for a sign-in link. You can close this tab.
              </Text>
              {/* The way out of the case this whole choice exists for: the
                  link arrived and signed them in somewhere that was not
                  here. Back to the form, with the code option a tap away. */}
              <Anchor component="button" type="button" size="sm" onClick={startOver}>
                Start over
              </Anchor>
            </>
          ) : (
            <>
              <Text c="dimmed" ta="center">
                Enter your email to sign in
              </Text>
              <TextInput
                w="100%"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              />
              <SegmentedControl
                w="100%"
                value={method}
                onChange={(value) => setMethod(value as SignInMethod)}
                data={[
                  { value: 'link', label: 'Email a link' },
                  { value: 'code', label: 'Email a code' },
                ]}
              />
              {error && (
                <Text c="red" size="sm">
                  {error}
                </Text>
              )}
              <Button fullWidth onClick={handleSubmit} loading={sending}>
                {method === 'link' ? 'Send sign-in link' : 'Send sign-in code'}
              </Button>
              {/* Shown either way: someone who has just requested a link has a
              minute to spare, and may have no idea what STAR voting is. */}
              <Anchor component={Link} to="/about" size="sm">
                What is STAR voting?
              </Anchor>
            </>
          )}
        </Stack>
      </Paper>
    </Center>
  )
}
