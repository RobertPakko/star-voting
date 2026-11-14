import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Button,
  Card,
  Collapse,
  Group,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core'
import {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowElbowDownRightIcon,
  CaretRightIcon,
  PencilSimpleIcon,
} from '@phosphor-icons/react'
import { CHOICES, type Choice } from '../lib/choices'
import { CHOICE_GUIDE, isChoice, type GuideQuestion } from '../lib/choiceGuide'
import { CHOICE_ICONS } from './choiceIcons'
import { Reveal } from './Reveal'
import { TryItButton } from './NewPollButton'
import classes from './ChoiceGuide.module.css'

/**
 * *Which choice do I need?* at the top of `/choices`: the questions of
 * `CHOICE_GUIDE`, one at a time, ending on a choice with the ways on from it
 * (its section, its example, the create form). An answered question stays on
 * screen, folded to its question and the answer given, and pressing it asks it
 * again, dropping everything after; so the questions answered are the trail
 * back, with no breadcrumb of their own. *See the whole decision tree*
 * unfolds the same questions as an outline (`Tree`), every answer indented
 * under its question and ending on the next question or a choice, for a
 * reader who would rather scan than answer.
 *
 * Not a drawn flowchart: the answers are sentences, and a tree four deep with
 * seven ends does not fit a phone, where an outline indented a step a level
 * does. The card grows by a line or two a step.
 */
export function ChoiceGuide({
  example,
  onRead,
}: {
  /** Where *See an example* goes for a choice: the page's own `exampleFor`. */
  example: (choice: Choice) => string
  /** *Read about it*: open the choice's section and bring it up. */
  onRead: (choice: Choice) => void
}) {
  // The index of the answer given to each question so far.
  const [taken, setTaken] = useState<number[]>([])
  const [wholeTree, setWholeTree] = useState(false)
  const treeId = useId()
  // The step just reached takes focus, since the button pressed is gone;
  // nothing does on the page's first render.
  const current = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  useEffect(() => {
    if (moved.current) current.current?.focus()
  }, [taken])

  const steps: { question: GuideQuestion; answer: string }[] = []
  let at: GuideQuestion | Choice = CHOICE_GUIDE
  for (const index of taken) {
    if (isChoice(at)) break
    steps.push({ question: at, answer: at.answers[index].answer })
    at = at.answers[index].next
  }

  function go(next: number[]) {
    moved.current = true
    setTaken(next)
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md">
        {steps.map(({ question, answer }, depth) => (
          <UnstyledButton
            key={question.question}
            className={classes.answered}
            onClick={() => go(taken.slice(0, depth))}
          >
            <Group gap="sm" wrap="nowrap" justify="space-between">
              <Stack gap={0}>
                <Text size="sm" c="dimmed">
                  {question.question}
                </Text>
                <Text fw={600}>{answer}</Text>
              </Stack>
              <PencilSimpleIcon size={16} aria-hidden className={classes.change} />
              <VisuallyHidden>(change this answer)</VisuallyHidden>
            </Group>
          </UnstyledButton>
        ))}

        <Reveal key={taken.join('-')} enter={taken.length > 0}>
          <div ref={current} tabIndex={-1} className={classes.step}>
            {isChoice(at) ? (
              <Answer choice={at} example={example(at)} onRead={() => onRead(at as Choice)} />
            ) : (
              <Stack gap="xs">
                <Text fw={700}>{at.question}</Text>
                {at.answers.map(({ answer }, index) => (
                  <Button
                    key={answer}
                    variant="default"
                    fullWidth
                    className={classes.option}
                    classNames={{ inner: classes.optionInner, label: classes.optionLabel }}
                    rightSection={<CaretRightIcon size={16} aria-hidden />}
                    onClick={() => go([...taken, index])}
                  >
                    {answer}
                  </Button>
                ))}
              </Stack>
            )}
          </div>
        </Reveal>

        <Group justify="space-between" gap="xs">
          <Button
            variant="subtle"
            size="compact-sm"
            aria-expanded={wholeTree}
            aria-controls={treeId}
            onClick={() => setWholeTree((open) => !open)}
          >
            {wholeTree ? 'Hide the decision tree' : 'See the decision tree'}
          </Button>
          {taken.length > 0 && (
            <Button
              variant="subtle"
              size="compact-sm"
              leftSection={<ArrowCounterClockwiseIcon size={14} aria-hidden />}
              onClick={() => go([])}
            >
              Start over
            </Button>
          )}
        </Group>

        {/* Unmounted while folded, so its copies of the questions are not on the
            page twice. */}
        <Collapse expanded={wholeTree} id={treeId} keepMounted={false}>
          <Tree question={CHOICE_GUIDE} onRead={onRead} />
        </Collapse>
      </Stack>
    </Card>
  )
}

/**
 * The whole guide as an outline: a question, then each of its answers
 * indented under it with a line down the side, and under each answer the
 * question it leads to or the choice it ends on. A nested list, so a screen
 * reader hears the levels. A choice is a button that opens its section, as
 * *Read about it* does.
 */
function Tree({ question, onRead }: { question: GuideQuestion; onRead: (choice: Choice) => void }) {
  return (
    <Stack gap={4}>
      <Text fw={700} size="sm">
        {question.question}
      </Text>
      <ul className={classes.branches}>
        {question.answers.map(({ answer, next }) => (
          <li key={answer} className={classes.branch}>
            <Group gap={6} wrap="nowrap" align="flex-start">
              <ArrowElbowDownRightIcon size={14} aria-hidden className={classes.elbow} />
              <Text size="sm" c="dimmed">
                {answer}
              </Text>
            </Group>
            <div className={classes.next}>
              {isChoice(next) ? (
                <Leaf choice={next} onRead={() => onRead(next)} />
              ) : (
                <Tree question={next} onRead={onRead} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </Stack>
  )
}

/** Where a branch of `Tree` ends: the choice, which opens its section. */
function Leaf({ choice, onRead }: { choice: Choice; onRead: () => void }) {
  const { icon: Glyph, color } = CHOICE_ICONS[choice]
  return (
    <UnstyledButton className={classes.leaf} onClick={onRead}>
      <Group gap="xs" wrap="nowrap">
        <ThemeIcon size={24} radius="sm" variant="light" color={color}>
          <Glyph size={14} aria-hidden />
        </ThemeIcon>
        <Text size="sm" fw={700}>
          {CHOICES[choice].label}
        </Text>
      </Group>
    </UnstyledButton>
  )
}

/** Where the guide ends: the choice, its sentence, and the ways on from it. */
function Answer({
  choice,
  example,
  onRead,
}: {
  choice: Choice
  example: string
  onRead: () => void
}) {
  const { icon: Glyph, color } = CHOICE_ICONS[choice]
  const { label, blurb } = CHOICES[choice]
  return (
    <Stack gap="sm">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon size={40} radius="md" variant="light" color={color}>
          <Glyph size={22} aria-hidden />
        </ThemeIcon>
        <Text>
          <strong>{label}</strong> {blurb}
        </Text>
      </Group>
      <Group justify="flex-end" align="flex-start" gap="sm">
        <Button
          variant="subtle"
          leftSection={<ArrowDownIcon size={16} aria-hidden />}
          onClick={onRead}
        >
          Read about it
        </Button>
        <Button component={Link} to={example} variant="light">
          See an example
        </Button>
        <TryItButton choice={choice} />
      </Group>
    </Stack>
  )
}
