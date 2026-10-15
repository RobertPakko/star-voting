import { useEffect, useState, type ReactNode } from 'react'
import { Anchor, Button, Card, Group, Progress, Skeleton, Stack, Text, Title } from '@mantine/core'
import { HeartIcon } from '@phosphor-icons/react'
import { countsRaised, donateUrl, fetchRaised, type Raised } from '../lib/support'
import { usePageTitle } from '../lib/pageTitle'
import classes from './Support.module.css'

/**
 * The /support route: the site costs nothing to use, and this is where its
 * readers are asked to say thanks to a charity instead. Public, like About —
 * the readers most likely to want it are the ones who arrived on a share
 * link.
 *
 * The donate button goes to Every.org rather than to the charity's own form,
 * because Every.org can say how much its fundraiser has raised and the
 * charity's form cannot; see "The support page" in AGENTS.md for why that
 * costs a donor nothing on their taxes.
 */
export function Support() {
  usePageTitle('Support')

  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1}>Support</Title>

      <Text>
        STAR Voting is free to use, with no ads and no subscriptions, and I’m happy to cover the
        costs of running it out of my own pocket.
      </Text>
      <Text>
        If it’s helped your group make a decision, it would mean a lot if you would consider making
        a tax-deductible donation to my fundraiser. I chose Khan Academy because it’s made a huge
        difference in my life and I want to give it the support it needs to help future generations.
        Everything given through the button below is counted here, so we can see what this little
        site adds up to together.
      </Text>
      <Text className={classes.signature}>— Rob</Text>

      <Card withBorder>
        <Stack gap="md">
          <Group gap="sm" wrap="nowrap">
            {/* Decoration: the name beside it is what a screen reader needs.
                A copy of the logo Every.org shows, kept here so the page
                asks nobody else for it. It is opaque white around the mark,
                so it is drawn as a tile, which holds up on a dark card. */}
            <img
              src={`${import.meta.env.BASE_URL}khan-academy.png`}
              alt=""
              width={48}
              height={48}
              style={{ borderRadius: 12, display: 'block', flexShrink: 0 }}
            />
            <Title order={2} size="h4">
              Khan Academy
            </Title>
          </Group>
          <Text size="sm">
            Khan Academy is a nonprofit with a mission to provide a free, world-class education for
            anyone, anywhere. Its lessons, practice exercises and teaching tools in math, science,
            reading and more are free to every learner and teacher, with no ads and no
            subscriptions.
          </Text>
          {countsRaised && <RaisedCount />}
          <Group justify="space-between" gap="md">
            <Button
              component="a"
              href={donateUrl()}
              target="_blank"
              rel="noopener noreferrer"
              leftSection={<HeartIcon size={16} weight="fill" aria-hidden />}
            >
              Donate
            </Button>
            <External href="https://www.khanacademy.org/" inherit={false}>
              khanacademy.org
            </External>
          </Group>
        </Stack>
      </Card>

      {/* Only cash gifts count — not stock, crypto, or a gift out of a
          donor-advised fund — which is left unsaid: the people giving those
          know what they are giving, and the sentence that said so read as a
          riddle to everybody else. See AGENTS.md. */}
      <Text size="sm" c="dimmed">
        For US donors: starting in 2026, you can deduct up to $1,000 of cash donations to charity
        ($2,000 if married filing jointly) even if you don’t itemize. Learn more at{' '}
        <External href="https://www.irs.gov/taxtopics/tc506">irs.gov</External>.
      </Text>
    </Stack>
  )
}

/**
 * What has been given through this page so far, and how far that is towards
 * the fundraiser's goal. Read once on arrival: a reader who has just donated
 * is in Every.org's tab, not this one, and the count moves when somebody
 * gives rather than while anybody watches.
 *
 * Its shape stands in while it is asked for, and it disappears if the answer
 * does not come — it is a nicety beside the button, not something to wait on.
 * The bar is drawn empty during the wait, so it grows to its length when the
 * answer lands rather than appearing at it.
 */
function RaisedCount() {
  const [raised, setRaised] = useState<Raised | null | undefined>(undefined)

  useEffect(() => {
    const abort = new AbortController()
    void fetchRaised(abort.signal).then((answer) => {
      if (!abort.signal.aborted) setRaised(answer)
    })
    return () => abort.abort()
  }, [])

  if (raised === null) return null

  const goal = raised?.goal
  const share = raised && goal ? Math.min(100, (raised.dollars / goal.dollars) * 100) : 0
  const towards =
    raised && goal
      ? `${dollars.format(raised.dollars)} of ${goal.milestone ? 'the next milestone' : 'the goal'}, ${dollars.format(goal.dollars)}`
      : 'Amount raised'

  return (
    <Stack gap={6} aria-busy={raised === undefined}>
      {raised ? (
        <Text size="sm" c="dimmed">
          <Text span fz="xl" fw={700} c="var(--mantine-color-text)">
            {dollars.format(raised.dollars)}
          </Text>{' '}
          raised through this site
        </Text>
      ) : (
        // The line a `fz="xl"` figure takes, with a bar inside it.
        <Skeleton height={22} width={200} my={4} radius="sm" />
      )}
      {(raised === undefined || goal) && (
        <Progress.Root size="md">
          <Progress.Section value={share} aria-label={towards} />
        </Progress.Root>
      )}
      {raised ? (
        <Group justify="space-between" gap="xs">
          <Text size="xs" c="dimmed">
            {raised.supporters.toLocaleString('en-US')}{' '}
            {raised.supporters === 1 ? 'donor' : 'donors'}
          </Text>
          {goal && (
            <Text size="xs" c="dimmed">
              {goal.milestone ? 'Next milestone' : 'Goal'}: {dollars.format(goal.dollars)}
            </Text>
          )}
        </Group>
      ) : (
        <Skeleton height={10} width={64} my={3.5} radius="sm" />
      )}
    </Stack>
  )
}

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/**
 * A link off the site, which gets a tab of its own like every other.
 * `inherit` for one set into a sentence, which the theme then underlines.
 */
function External({
  href,
  inherit = true,
  children,
}: {
  href: string
  inherit?: boolean
  children: ReactNode
}) {
  return (
    <Anchor href={href} target="_blank" rel="noopener noreferrer" inherit={inherit} size="sm">
      {children}
    </Anchor>
  )
}
