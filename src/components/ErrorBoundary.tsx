import { Component, type ReactNode } from 'react'
import { Button, Center, Paper, Stack, Text, Title } from '@mantine/core'

/**
 * The last thing between a render that throws and a white page.
 *
 * React unmounts the whole tree when an error reaches the root uncaught, and
 * what that leaves is not an error screen but *nothing* -- an empty `#root`,
 * a reader with no way of telling a broken app from a slow one, and the only
 * account of what happened in a console they are not looking at. A boundary
 * does not fix anything; it replaces that silence with a sentence and the
 * button they would otherwise have to know to press.
 *
 * **Refreshing really is the advice**, not a shrug. Every error this stands to
 * catch is one where the code that has already been loaded is in a state this
 * page cannot get out of, and a fresh page is the only thing that clears it.
 * The one it will catch most is the second failed chunk of a stale build: the
 * first is reloaded by [`lib/staleBuild.ts`](../lib/staleBuild.ts) without the
 * reader seeing anything, and a second inside its loop window is deliberately
 * left to throw, because a reload that did not work the first time is a reload
 * that will not work the second. This is what the reader gets instead, and the
 * refresh it offers is theirs to spend rather than another one taken for them.
 *
 * So it promises nothing beyond that. An app whose bundle is fine and whose
 * component threw will come back and throw again, and the second sentence says
 * as much rather than leaving somebody refreshing a page that is never going
 * to come good.
 *
 * **It is above the router, not inside it.** A boundary per route would keep
 * the header up and be nicer to look at, and would also be a boundary that is
 * itself part of what broke -- `Layout` and the router are the two things most
 * worth surviving an error in. This one is outside both, so the only thing it
 * depends on is Mantine's provider. It does not reset, for the same reason:
 * there is nothing to go back to that has not already failed once, and a
 * boundary that clears itself on a navigation is one that flickers the app
 * back and forth through the thing that threw.
 *
 * Nothing is logged. React reports an error it catches on its own, and this
 * app sends nothing anywhere -- there is no collector behind a `console.error`
 * here, and the reader's browser is where it would stay.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children

    // The sign-in screen's card, because that is what this app's one other
    // page with nothing behind it looks like.
    return (
      <Center h="100vh" p="md">
        <Paper withBorder shadow="sm" p="xl" radius="md" w={360}>
          <Stack align="center" gap="md">
            <Title order={3}>Something went wrong</Title>
            <Text c="dimmed" ta="center" size="sm">
              Refreshing the page usually clears it. If it keeps happening after a refresh, the
              problem is at our end rather than yours.
            </Text>
            <Button onClick={() => window.location.reload()}>Refresh the page</Button>
          </Stack>
        </Paper>
      </Center>
    )
  }
}
