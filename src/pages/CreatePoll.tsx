import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  SegmentedControl,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import type { PollMode } from '../lib/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function CreatePoll() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [mode, setMode] = useState<PollMode>('invite')
  const [showVoters, setShowVoters] = useState(true)
  const [emails, setEmails] = useState<string[]>([])
  const [includeSelf, setIncludeSelf] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const myEmail = session?.user.email?.toLowerCase() ?? ''
  const isOpen = mode === 'open'

  function updateOption(index: number, value: string) {
    setOptions((prev) => prev.map((c, i) => (i === index ? value : c)))
  }

  function addOption() {
    setOptions((prev) => [...prev, ''])
  }

  function removeOption(index: number) {
    setOptions((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSubmit() {
    setError(null)

    const cleanOptions = options.map((o) => o.trim()).filter(Boolean)
    const typedEmails = emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
    const allEmails = Array.from(new Set(includeSelf ? [...typedEmails, myEmail] : typedEmails))

    if (!title.trim()) {
      setError('Title is required.')
      return
    }
    if (cleanOptions.length < 2) {
      setError('Add at least two options.')
      return
    }
    if (!isOpen) {
      const invalidEmail = typedEmails.find((e) => !EMAIL_RE.test(e))
      if (invalidEmail) {
        setError(`"${invalidEmail}" doesn't look like a valid email address.`)
        return
      }
      if (allEmails.length === 0) {
        setError('Invite at least one voter, or include yourself.')
        return
      }
    }

    setSubmitting(true)
    // One transaction: the poll, its options, and its invitees land together
    // or not at all.
    const { data, error: rpcError } = await supabase.rpc('create_poll', {
      p_title: title.trim(),
      p_description: description.trim() || null,
      p_options: cleanOptions,
      p_emails: isOpen ? [] : allEmails,
      p_mode: mode,
      p_show_voters: showVoters,
    })
    setSubmitting(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }

    notifications.show({ message: 'Poll created', color: 'green' })
    navigate(`/polls/${data as string}`)
  }

  return (
    <Stack maw={560} mx="auto" gap="md">
      <Title order={2}>New poll</Title>

      <TextInput
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        required
      />
      <Textarea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        autosize
        minRows={2}
      />

      <Stack gap="xs">
        <Text fw={500} size="sm">
          Options
        </Text>
        {options.map((option, index) => (
          <Group key={index} gap="xs">
            <TextInput
              value={option}
              onChange={(e) => updateOption(index, e.currentTarget.value)}
              placeholder={`Option ${index + 1}`}
              style={{ flex: 1 }}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => removeOption(index)}
              disabled={options.length <= 2}
              aria-label="Remove option"
            >
              &times;
            </ActionIcon>
          </Group>
        ))}
        <Button variant="light" size="xs" onClick={addOption} w="fit-content">
          Add option
        </Button>
      </Stack>

      <Stack gap="xs">
        <Text fw={500} size="sm">
          Who can vote
        </Text>
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as PollMode)}
          data={[
            { value: 'invite', label: 'Invited people' },
            { value: 'open', label: 'Anyone with the link' },
          ]}
        />
        <Text size="xs" c="dimmed">
          {isOpen
            ? 'Voters open a link and score the options. No sign-in, no account.'
            : "Voters sign in with their email. Only addresses on the invite list can see or vote in the poll."}
        </Text>
      </Stack>

      {isOpen && (
        <Alert color="yellow" title="Anyone with the link can vote">
          <Stack gap={4}>
            <Text size="sm">
              There is no sign-in, so there is no way to tell voters apart. Anyone the link reaches
              can vote, and one person can vote more than once by using another browser or clearing
              their site data.
            </Text>
            <Text size="sm">
              Good for picking a movie. Not good for anything where the outcome actually matters —
              use an invite poll for that.
            </Text>
          </Stack>
        </Alert>
      )}

      <Switch
        checked={showVoters}
        onChange={(e) => setShowVoters(e.currentTarget.checked)}
        label="Show who has responded"
        description={
          showVoters
            ? isOpen
              ? 'Voters enter a name with their ballot, and everyone can see who has voted so far. How they voted stays private.'
              : 'Everyone in the poll can see which invitees have voted and which are still pending. How they voted stays private.'
            : 'Only the number of votes is shown — nobody, including you, can see who has responded.'
        }
      />

      {!isOpen && (
        <Stack gap="xs">
          <TagsInput
            label="Invite voters"
            description="Type an email and press Enter (or comma) to add it."
            placeholder="them@example.com"
            value={emails}
            onChange={setEmails}
          />
          <Checkbox
            label={`Include me as a voter (${myEmail})`}
            checked={includeSelf}
            onChange={(e) => setIncludeSelf(e.currentTarget.checked)}
          />
        </Stack>
      )}

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}

      <Group justify="flex-end">
        <Button onClick={handleSubmit} loading={submitting}>
          Create poll
        </Button>
      </Group>
    </Stack>
  )
}
