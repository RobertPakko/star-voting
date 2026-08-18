import { Alert, List, Text } from '@mantine/core'
import type { PollMode } from '../lib/types'

/**
 * What happens to your ballot, said plainly, on the form where you cast it.
 *
 * Publishing ballots is only defensible if the person filling one in knew it
 * was going to happen — so this sits on both voting forms themselves, not in a
 * settings summary somewhere else. It sits below the submit button: the ballot
 * outranks the notice for position, and being on the same screen before
 * anything is sent is what actually makes it honest. It reports two independent
 * facts in a fixed order:
 *
 *   1. Will your scores be published, and with your name on them?
 *   2. Will the fact that you responded be visible?
 *
 * Both are frozen at creation, so nothing said here can change under someone
 * after they read it.
 */
export function BallotPrivacy({
  mode,
  showVoters,
  showBallots,
}: {
  mode: PollMode
  showVoters: boolean
  showBallots: boolean
}) {
  // How this poll identifies people at all: an invite poll knows the address
  // you signed in with, an open poll only the name you type on the form.
  const identity = mode === 'open' ? 'the name you enter below' : 'your email address'

  const title = showBallots
    ? showVoters
      ? 'Your ballot will be published with your name'
      : 'Your ballot will be published anonymously'
    : 'Your ballot is private'

  return (
    <Alert color={showBallots && showVoters ? 'yellow' : 'blue'} title={title}>
      <List size="sm" spacing={4}>
        <List.Item>
          {showBallots ? (
            showVoters ? (
              <>
                Once the results unlock, everyone in this poll can see the score you gave every
                option, listed next to {identity}.
              </>
            ) : (
              <>
                Once the results unlock, everyone in this poll can see the scores on every ballot,
                including yours — but no name is shown against any of them, and they are listed in
                an order unrelated to when they were cast.
              </>
            )
          ) : (
            <>Nobody sees how you scored the options. Only the totals are published.</>
          )}
        </List.Item>
        <List.Item>
          {showVoters ? (
            <>Everyone in this poll can see that you responded, listed by {identity}.</>
          ) : (
            <>Nobody is shown who has responded — only how many have.</>
          )}
        </List.Item>
        {!showBallots && (
          <List.Item>
            Nothing is revealed until the results unlock, so no vote is ever cast knowing how the
            poll is going.
          </List.Item>
        )}
      </List>
      {showBallots && (
        <Text size="xs" c="dimmed" mt={6}>
          Nothing is revealed until the results unlock, so no vote is ever cast knowing how the poll
          is going. This poll's setting was fixed when it was created and can't be changed now.
        </Text>
      )}
    </Alert>
  )
}
