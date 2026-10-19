import { useState, type FormEvent } from 'react'
import { Anchor, Button, Card, Group, Stack, Text, TextInput, Textarea, Title } from '@mantine/core'
import { CheckIcon, PaperPlaneRightIcon, PlusIcon } from '@phosphor-icons/react'
import { Signature } from '../components/Signature'
import { announce } from '../lib/announce'
import { useAuth } from '../lib/auth'
import { CONTACT_EMAIL_MAX, CONTACT_MESSAGE_MAX, tooLong } from '../lib/limits'
import { usePageTitle } from '../lib/pageTitle'
import { supabase } from '../lib/supabase'

/** GitHub's form for a new issue on this repository. */
const NEW_ISSUE = 'https://github.com/RobertPakko/star-voting/issues/new'

/** The shape `send_contact_message` asks of an address, and `invited_voters`. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The /contact route: a reply address and a message, for bugs, feature
 * requests and anything else. Public, like About and Donate — the reader most
 * likely to have something to say is the one who arrived on a share link.
 *
 * A message is a row in `contact_messages`, put there by
 * `send_contact_message`, which also emails it to the owner with the sender as
 * Reply-To, and nothing in the app reads it back; see "The
 * contact page" in AGENTS.md. The address is filled in from the account where
 * there is one, since that is where a reply would go, and can be changed.
 *
 * The fields are checked on the press and cleared as each is corrected, the
 * way every form in the app is (see "What a form checks before it sends").
 */
export function Contact() {
  usePageTitle('Contact')
  const { session } = useAuth()
  const [email, setEmail] = useState(session?.user.email ?? '')
  const [message, setMessage] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const trimmedEmail = email.trim()
  const trimmedMessage = message.trim()
  const emailError = !trimmedEmail
    ? 'Enter an email address so I can reply'
    : trimmedEmail.length > CONTACT_EMAIL_MAX
      ? tooLong('An email address', trimmedEmail.length, CONTACT_EMAIL_MAX)
      : !EMAIL.test(trimmedEmail)
        ? 'That doesn’t look like an email address'
        : null
  const messageError = !trimmedMessage
    ? 'Write a message to send'
    : trimmedMessage.length > CONTACT_MESSAGE_MAX
      ? tooLong('A message', trimmedMessage.length, CONTACT_MESSAGE_MAX)
      : null

  async function send(event: FormEvent) {
    event.preventDefault()
    setShowErrors(true)
    setError(null)
    if (emailError || messageError) {
      // Focus is how a screen reader finds out the press was refused.
      document.getElementById(emailError ? 'contact-email' : 'contact-message')?.focus()
      return
    }
    setSending(true)
    const { error: sendError } = await supabase.rpc('send_contact_message', {
      p_email: trimmedEmail,
      p_message: trimmedMessage,
    })
    setSending(false)
    if (sendError) {
      setError(sendError.message)
      return
    }
    setSent(true)
    setMessage('')
    setShowErrors(false)
    announce('Message sent')
  }

  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1}>Contact</Title>

      <Text>
        Bugs? Feature requests? UI issues? Contact me using the form below and I&rsquo;ll get back
        to you, or{' '}
        <Anchor href={NEW_ISSUE} target="_blank" rel="noopener noreferrer" inherit>
          file an issue on GitHub
        </Anchor>{' '}
        directly.
      </Text>
      <Signature />

      <Card withBorder>
        {sent ? (
          <Stack gap="md" align="flex-start">
            <Group gap="xs" wrap="nowrap">
              <CheckIcon size={20} weight="bold" color="var(--mantine-color-green-8)" aria-hidden />
              <Text fw={600}>Thanks!</Text>
            </Group>
            <Text size="sm" c="dimmed">
              I&rsquo;ll reply to {trimmedEmail}.
            </Text>
            <Button
              variant="default"
              leftSection={<PlusIcon size={16} aria-hidden />}
              onClick={() => setSent(false)}
            >
              Send another message
            </Button>
          </Stack>
        ) : (
          <form onSubmit={(event) => void send(event)} noValidate>
            <Stack gap="md">
              <TextInput
                id="contact-email"
                type="email"
                label="Your email address"
                description="So I can reply to you"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
                error={showErrors && emailError}
              />
              <Textarea
                id="contact-message"
                label="Message"
                autosize
                minRows={6}
                value={message}
                onChange={(event) => setMessage(event.currentTarget.value)}
                error={showErrors && messageError}
              />
              {error && (
                <Text role="alert" c="red" size="sm">
                  {error}
                </Text>
              )}
              <Group>
                <Button
                  type="submit"
                  loading={sending}
                  leftSection={<PaperPlaneRightIcon size={16} aria-hidden />}
                >
                  Send message
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Card>
    </Stack>
  )
}
