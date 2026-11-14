import { Button, Stack, Text, type ButtonProps } from '@mantine/core'
import { PlusIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { tryPath, useMakePoll } from '../lib/makePoll'
import type { Choice, Variant } from '../lib/choices'

/**
 * A link to the create form that also works for a reader with no session,
 * who is given one on the press (`useMakePoll`), as the home page's tile
 * does. The error, if that fails, is drawn under the button.
 */
function MakePollButton({
  to,
  children,
  ...button
}: { to: string; children: string } & Omit<ButtonProps, 'children'>) {
  const { start, starting, error } = useMakePoll(to)

  return (
    <>
      <Button
        component={Link}
        to={to}
        loading={starting}
        onClick={
          start
            ? (event: React.MouseEvent) => {
                event.preventDefault()
                void start()
              }
            : undefined
        }
        {...button}
      >
        {children}
      </Button>
      {error && (
        <Text role="alert" c="red" size="sm" w="100%" ta="right">
          {error}
        </Text>
      )}
    </>
  )
}

/**
 * *New poll*, at the top right of *What is STAR?* and *Why use STAR?*: drawn
 * by `Layout` in one row with the way home, as the poll list draws its own.
 * `/choices` and `/variants` carry a *Try it out* on every section instead.
 */
export function NewPollButton() {
  return (
    <MakePollButton to="/new" size="compact-sm" leftSection={<PlusIcon size={14} aria-hidden />}>
      New poll
    </MakePollButton>
  )
}

/**
 * *Try it out*: the create form with its first question already on a choice
 * or a variant (`tryPath`), beside *See an example* on `/choices` and
 * `/variants` and at the end of the choice guide.
 */
export function TryItButton({ choice, variant }: { choice?: Choice; variant?: Variant }) {
  return (
    <Stack gap={4} align="flex-end">
      <MakePollButton
        to={tryPath({ choice, variant })}
        leftSection={<PlusIcon size={16} aria-hidden />}
      >
        Try it out
      </MakePollButton>
    </Stack>
  )
}
