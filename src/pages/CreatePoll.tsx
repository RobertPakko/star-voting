import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ActionIcon,
  Button,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function CreatePoll() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [candidates, setCandidates] = useState(['', ''])
  const [emailsText, setEmailsText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateCandidate(index: number, value: string) {
    setCandidates((prev) => prev.map((c, i) => (i === index ? value : c)))
  }

  function addCandidate() {
    setCandidates((prev) => [...prev, ''])
  }

  function removeCandidate(index: number) {
    setCandidates((prev) => prev.filter((_, i) => i !== index))
  }

  function parseEmails(): string[] {
    const raw = emailsText
      .split(/[\n,]/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
    return Array.from(new Set(raw))
  }

  async function handleSubmit() {
    setError(null)

    const trimmedTitle = title.trim()
    const cleanCandidates = candidates.map((c) => c.trim()).filter(Boolean)
    const emails = parseEmails()

    if (!trimmedTitle) {
      setError('Title is required.')
      return
    }
    if (cleanCandidates.length < 2) {
      setError('Add at least two candidates.')
      return
    }
    const invalidEmail = emails.find((e) => !EMAIL_RE.test(e))
    if (invalidEmail) {
      setError(`"${invalidEmail}" doesn't look like a valid email address.`)
      return
    }
    if (emails.length === 0) {
      setError('Invite at least one voter by email.')
      return
    }

    setSubmitting(true)
    try {
      const { data: poll, error: pollError } = await supabase
        .from('polls')
        .insert({ title: trimmedTitle, description: description.trim() || null, created_by: session!.user.id })
        .select()
        .single()

      if (pollError || !poll) throw pollError ?? new Error('Failed to create poll')

      const { error: candidatesError } = await supabase.from('candidates').insert(
        cleanCandidates.map((name, index) => ({
          poll_id: poll.id,
          name,
          sort_order: index,
        })),
      )
      if (candidatesError) throw candidatesError

      const { error: votersError } = await supabase.from('invited_voters').insert(
        emails.map((email) => ({ poll_id: poll.id, email })),
      )
      if (votersError) throw votersError

      notifications.show({ message: 'Poll created', color: 'green' })
      navigate(`/polls/${poll.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong creating the poll.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Stack maw={560} mx="auto" gap="md">
      <Title order={2}>New poll</Title>

      <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required />
      <Textarea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        autosize
        minRows={2}
      />

      <Stack gap="xs">
        <Text fw={500} size="sm">
          Candidates
        </Text>
        {candidates.map((candidate, index) => (
          <Group key={index} gap="xs">
            <TextInput
              value={candidate}
              onChange={(e) => updateCandidate(index, e.currentTarget.value)}
              placeholder={`Candidate ${index + 1}`}
              style={{ flex: 1 }}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => removeCandidate(index)}
              disabled={candidates.length <= 2}
              aria-label="Remove candidate"
            >
              &times;
            </ActionIcon>
          </Group>
        ))}
        <Button variant="light" size="xs" onClick={addCandidate} w="fit-content">
          Add candidate
        </Button>
      </Stack>

      <Textarea
        label="Invite voters"
        description="One email per line (or comma-separated)."
        value={emailsText}
        onChange={(e) => setEmailsText(e.currentTarget.value)}
        autosize
        minRows={3}
      />

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
