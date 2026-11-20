import type { Choice } from './choices'

/**
 * The questions `/choices` asks to point a reader at a choice
 * (`ChoiceGuide`): a tree whose every answer leads to another question or to
 * a choice. Data rather than markup so the guide, its *See every path* list
 * and the test that every choice is reachable read one copy. Answers are
 * ordered so the choices are reached in the order `/choices` lists them
 * (`choiceGuide.test.ts` checks it).
 */
export interface GuideQuestion {
  question: string
  answers: GuideAnswer[]
}

export interface GuideAnswer {
  answer: string
  next: GuideQuestion | Choice
}

const proportional: GuideQuestion = {
  question: 'Do you want winners to be chosen proportionally?',
  answers: [
    { answer: 'No, let’s keep it purely utilitarian', next: 'ranking' },
    { answer: 'Yes, let’s keep a majority from picking every winner', next: 'multiple' },
  ],
}

const affected: GuideQuestion = {
  question: 'Will all winning options affect all voters?',
  answers: [
    { answer: 'Yes, everyone will be affected by all winning options', next: proportional },
    {
      answer: 'No, everyone will pick an option from among the winning options',
      next: 'consensus_winners',
    },
  ],
}

const split: GuideQuestion = {
  question: 'Can we just take a little of each option?',
  answers: [
    { answer: 'No, picking an option is all-or-nothing', next: affected },
    { answer: 'Sure, we could do that', next: 'fractional' },
  ],
}

const veto: GuideQuestion = {
  question: 'Should voters get to veto an option that they don’t like?',
  answers: [
    { answer: 'No, we want what’s best for the group as a whole', next: 'option' },
    { answer: 'Yes, we want everyone to be at least a little satisfied', next: 'consensus' },
  ],
}

export const CHOICE_GUIDE: GuideQuestion = {
  question: 'What does your group want to do?',
  answers: [
    { answer: 'Pick an option', next: veto },
    { answer: 'Pick multiple options', next: split },
    { answer: 'Assign voters to options', next: 'assignment' },
    { answer: 'Split voters into groups', next: 'groups' },
  ],
}

export const isChoice = (next: GuideQuestion | Choice): next is Choice => typeof next === 'string'

/** Every way through the guide: the answers given, in order, and the choice they reach. */
export function guidePaths(
  from: GuideQuestion = CHOICE_GUIDE,
  taken: string[] = [],
): { answers: string[]; choice: Choice }[] {
  return from.answers.flatMap(({ answer, next }) =>
    isChoice(next)
      ? [{ answers: [...taken, answer], choice: next }]
      : guidePaths(next, [...taken, answer]),
  )
}
