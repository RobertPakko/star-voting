import { Card, Text } from '@mantine/core'

/**
 * The sentences a poll says about where it has got to, written once.
 *
 * Every one of them is on at least two screens. The same poll is read as an
 * account on `PollDetail` and through its link on `PublicPoll`, an open poll
 * is read both ways by its own creator, and the two readings render from
 * different state — `poll_status` on one side, `open_poll_view` on the other
 * — so nothing but a shared component keeps them saying the same thing. Kept
 * as copies they had already drifted: the same two sentences about changing
 * your vote were laid out one way on the ballot and another on the card you
 * came back to. A poll that describes its own stage differently depending on
 * which door you came in by reads as two polls.
 *
 * What differs between the two kinds of poll is *which* sentence is true, not
 * how it is worded, so that is what these take as props.
 */

/**
 * A poll that is still a list rather than a ballot, under the options it is
 * collecting. The creator is told they end the stage, because they do;
 * everyone else is told who will.
 */
export function CollectingNote({ isCreator }: { isCreator: boolean }) {
  return (
    <Text size="sm" c="dimmed">
      {isCreator
        ? 'Voting hasn’t started. Everyone can add options until you open the poll.'
        : 'Voting hasn’t started. Everyone can add options until the poll’s creator opens the poll.'}
    </Text>
  )
}

/**
 * A poll that was closed with nothing in it, in place of the results it has
 * none of.
 *
 * Closing acts on the whole poll, so one question of several can end empty
 * while the rest have results: `inGroup` is what keeps this from calling that
 * question "this poll", which would be wrong about the poll and about the
 * question alike.
 */
export function NoResultsNotice({ inGroup }: { inGroup: boolean }) {
  return (
    <Card withBorder>
      <Text fw={500}>
        {inGroup
          ? 'The poll was closed before anyone answered this question, so it has no results.'
          : 'This poll was closed before anyone voted, so there are no results.'}
      </Text>
    </Card>
  )
}

/**
 * Which event puts the results on screen, and it is the two kinds of poll's
 * one real difference at this point: an invite poll unlocks itself the moment
 * its last invitee votes, with nobody closing anything, while an open poll
 * waits for its creator to close it.
 */
export type Reveal = { kind: 'invite' } | { kind: 'open'; isCreator: boolean }

function revealSentence(reveal: Reveal) {
  if (reveal.kind === 'invite') {
    return 'Results unlock automatically once everyone invited has voted.'
  }
  return reveal.isCreator
    ? 'Results are revealed once you close the poll.'
    : 'Results are revealed once the poll is closed by its creator.'
}

/**
 * When the results come out, and — for as long as they have not — that the
 * vote can still be changed.
 *
 * The two facts are one sentence apart deliberately: the window for a
 * revision is exactly "the results are not out yet", so the line that says
 * when they arrive is the line that says when the window shuts. Shown on the
 * ballot as it is filled in and on the card the voter comes back to
 * afterwards, which is why it is a component rather than a string.
 *
 * `canRevise` is false in one place only: an open-poll ballot cast before the
 * database could hand it back has nothing to reopen, so it is not offered
 * something that could not happen.
 */
export function RevealNote({
  reveal,
  canRevise = false,
  grow = false,
}: {
  reveal: Reveal
  canRevise?: boolean
  /** Share the row with a control rather than sitting beside it. */
  grow?: boolean
}) {
  return (
    <Text size="sm" c="dimmed" style={grow ? { flex: 1, minWidth: 220 } : undefined}>
      {revealSentence(reveal)}
      {canRevise && (
        <>
          <br />
          You can change your vote until then.
        </>
      )}
    </Text>
  )
}
