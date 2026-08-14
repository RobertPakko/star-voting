import { useState } from 'react'
import { Button, Center, Paper, Stack, Text, TextInput, Title } from '@mantine/core'
import { useAuth } from '../lib/auth'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function SignIn() {
  const { signInWithEmail } = useAuth()
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
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
      await signInWithEmail(trimmed)
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send sign-in link.')
    } finally {
      setSending(false)
    }
  }

  return (
    <Center h="100vh">
      <Paper withBorder shadow="sm" p="xl" radius="md" w={360}>
        <Stack align="center" gap="md">
          <Title order={2}>STAR Voting</Title>
          {sent ? (
            <Text ta="center">
              Check <strong>{email}</strong> for a sign-in link. You can close this tab.
            </Text>
          ) : (
            <>
              <Text c="dimmed" ta="center">
                Enter your email to get a sign-in link for polls you've been invited to.
              </Text>
              <TextInput
                w="100%"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              />
              {error && (
                <Text c="red" size="sm">
                  {error}
                </Text>
              )}
              <Button fullWidth onClick={handleSubmit} loading={sending}>
                Send sign-in link
              </Button>
            </>
          )}
        </Stack>
      </Paper>
    </Center>
  )
}
