import { Link } from 'react-router-dom'
import { Button, Stack, Text, Title } from '@mantine/core'

/**
 * The catch-all: an address this app has no page for.
 *
 * Reached by a mistyped URL and by a link to a route that no longer exists.
 * Without it a signed-in reader who fat-fingered one got the app shell with
 * an empty body -- a header, and nothing under it saying why -- which reads
 * as a page that failed to load rather than as an address that isn't one.
 *
 * It says the same two things the poll pages' "poll not found" card says: what
 * happened, and that the reader is not stuck. The way out is the poll list,
 * because that is what `/` is to somebody signed in, and because a link back
 * to a page that exists is the only useful thing this page has to offer.
 *
 * Inside the shell rather than bare, unlike the sign-in screen: there is
 * somewhere else to go from here, and the header is how you get there.
 */
export function NotFound() {
  return (
    <Stack maw={720} mx="auto" gap="md" align="center">
      <Title order={3}>Page not found</Title>
      <Text c="dimmed" ta="center">
        This address may be mistyped, or the page may have moved.
      </Text>
      <Button component={Link} to="/" variant="light">
        Back to your polls
      </Button>
    </Stack>
  )
}
