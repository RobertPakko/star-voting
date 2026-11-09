import { Button, Text } from '@mantine/core'
import { PlusIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { useMakePoll } from '../lib/makePoll'

/**
 * *New poll*, at the top right of the explainers a reader is likeliest to
 * finish wanting to try one: drawn by `Layout` in one row with the way home,
 * as the poll list draws its own. A reader with no session is given one on
 * the press (`useMakePoll`), as the home page's tile does.
 */
export function NewPollButton() {
  const { start, starting, error } = useMakePoll()

  return (
    <>
      <Button
        component={Link}
        to="/new"
        size="compact-sm"
        leftSection={<PlusIcon size={14} aria-hidden />}
        loading={starting}
        onClick={
          start
            ? (event: React.MouseEvent) => {
                event.preventDefault()
                void start()
              }
            : undefined
        }
      >
        New poll
      </Button>
      {error && (
        <Text role="alert" c="red" size="sm" w="100%" ta="right">
          {error}
        </Text>
      )}
    </>
  )
}
