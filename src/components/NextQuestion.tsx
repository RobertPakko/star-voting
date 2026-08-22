import { Link } from 'react-router-dom'
import { Button, Card, Group, Text } from '@mantine/core'

/**
 * The way on, once this question has been answered.
 *
 * The question strip at the top of the page can reach every question at any
 * time, and this is not a second copy of it: it is the one place a voter is
 * actually looking when they finish a ballot, and a poll that says "your vote
 * is in" with nothing to do next reads as a poll that is over. So it appears
 * only where it is the obvious next action — this question answered, another
 * one waiting — and says which question it is going to, so that pressing it
 * is a decision rather than a leap.
 *
 * Nothing renders when this is the last question. Being finished is a real
 * state and the strip above already shows it; inventing a button for it would
 * only be somewhere to click that leads back where you are.
 */
export function NextQuestion({ title, href }: { title: string; href: string }) {
  return (
    <Card withBorder>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
          Next question: {title}
        </Text>
        <Button component={Link} to={href} variant="light">
          Next question
        </Button>
      </Group>
    </Card>
  )
}
