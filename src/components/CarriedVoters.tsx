import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import { PlusIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { GIVEN_MAX, MAX_CARRIED, VOTER_NAME_MAX } from '../lib/limits'
import { blankCarried, type CarriedDraft } from '../lib/pollForm'

/**
 * A sequential question's earlier voters on the create form: who voted in the
 * polls before this one, and how many stars each gave their winners. Each
 * ballot counts at 5 ÷ (5 + stars); anyone not listed votes at the
 * average weight of those who are. *Create sequel poll* fills this in from a
 * finished poll, and it stays editable.
 *
 * On an invite poll the voters are the invite list (`carriedForInvitees`
 * keeps a row per invitee), so only the stars are typed here: an address is
 * never typed twice, and one left without stars is new to the run.
 */
export function CarriedVoters({
  rows,
  isOpen,
  onChange,
  listError,
  voterError,
  givenError,
}: {
  rows: CarriedDraft[]
  /** An open poll's voters are names; an invite poll's are its invitees' addresses. */
  isOpen: boolean
  onChange: (rows: CarriedDraft[]) => void
  listError?: string
  voterError: (index: number) => string | undefined
  givenError: (index: number) => string | undefined
}) {
  const patch = (index: number, edit: Partial<CarriedDraft>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...edit } : row)))

  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        Earlier voters
      </Text>
      <Text size="xs" c="dimmed">
        {isOpen
          ? 'Provide the stars each voter gave to previous winners so their ballot can be reweighted.'
          : 'Provide the stars each invitee gave to previous winners so their ballot can be reweighted. Leave it empty for anyone new, who counts at the average weight.'}{' '}
        <Anchor component={Link} to="/choices?section=sequential-polls" target="_blank" inherit>
          How this works
        </Anchor>
      </Text>

      {/* Column headings, since the boxes in each row are unlabelled to the
          eye; each box carries its own name for a screen reader. */}
      <Group gap="xs" wrap="nowrap" aria-hidden>
        <Text size="xs" fw={500} style={{ flex: 1 }}>
          {isOpen ? 'Name' : 'Email'}
        </Text>
        <Text size="xs" fw={500} w={{ base: 110, xs: 200 }} lh={1.2}>
          Stars given to previous winners
        </Text>
        {isOpen && <span style={{ width: 28 }} />}
      </Group>

      {!isOpen && rows.length === 0 && (
        <Text size="sm" c="dimmed">
          Add people to the invite list to give their stars here.
        </Text>
      )}

      {rows.map((row, index) => (
        <Group key={row.key} gap="xs" align="flex-start" wrap="nowrap">
          {isOpen ? (
            <TextInput
              style={{ flex: 1 }}
              aria-label={`Earlier voter ${index + 1}`}
              placeholder={`Voter ${index + 1}`}
              value={row.voter}
              onChange={(e) => patch(index, { voter: e.currentTarget.value })}
              error={voterError(index)}
              maxLength={VOTER_NAME_MAX}
            />
          ) : (
            // The invite list's own address; changed there, not here.
            <Text size="sm" mt={7} style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              {row.voter}
            </Text>
          )}
          <NumberInput
            w={{ base: 110, xs: 200 }}
            aria-label={
              isOpen
                ? `Stars voter ${index + 1} gave to previous winners`
                : `Stars ${row.voter} gave to previous winners`
            }
            placeholder={isOpen ? '0' : 'New'}
            value={row.given}
            onChange={(value) => patch(index, { given: value })}
            error={givenError(index)}
            min={0}
            max={GIVEN_MAX}
            decimalScale={6}
            allowNegative={false}
            hideControls
          />
          {isOpen && (
            <ActionIcon
              variant="subtle"
              color="red"
              mt={6}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              aria-label={`Remove earlier voter ${index + 1}`}
            >
              &times;
            </ActionIcon>
          )}
        </Group>
      ))}

      {listError && (
        <Text c="var(--mantine-color-error)" size="sm">
          {listError}
        </Text>
      )}

      {isOpen && (
        <Button
          variant="light"
          size="xs"
          w="fit-content"
          onClick={() => onChange([...rows, blankCarried()])}
          disabled={rows.length >= MAX_CARRIED}
          leftSection={<PlusIcon size={14} aria-hidden />}
        >
          Add voter
        </Button>
      )}
    </Stack>
  )
}
