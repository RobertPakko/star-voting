import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ActionIcon,
  Button,
  Group,
  Stack,
  TagsInput,
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
  const [options, setOptions] = useState(['', ''])
  const [emails, setEmails] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

    const trimmedTitle = title.trim()
    const cleanOptions = options.map((c) => c.trim()).filter(Boolean)
    const cleanEmails = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)))

    if (!trimmedTitle) {
      setError('Title is required.')
      return
    }
    if (cleanOptions.length < 2) {
      setError('Add at least two options.')
      return
    }
    const invalidEmail = cleanEmails.find((e) => !EMAIL_RE.test(e))
    if (invalidEmail) {
      setError(`"${invalidEmail}" doesn't look like a valid email address.`)
      return
    }
    if (cleanEmails.length === 0) {
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

      const { error: optionsError } = await supabase.from('candidates').insert(
        cleanOptions.map((name, index) => ({
          poll_id: poll.id,
          name,
          sort_order: index,
        })),
      )
      if (optionsError) throw optionsError

      const { error: votersError } = await supabase.from('invited_voters').insert(
        cleanEmails.map((email) => ({ poll_id: poll.id, email })),
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

      <TagsInput
        label="Invite voters"
        description="Type an email and press Enter (or comma) to add it."
        placeholder="you@example.com"
        value={emails}
        onChange={setEmails}
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
