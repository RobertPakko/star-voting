import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ActionIcon, Button, Card, Divider, Group, Stack, Text, TextInput } from '@mantine/core'
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  PencilSimpleIcon,
  PlusIcon,
} from '@phosphor-icons/react'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { PaintTimes } from './PaintTimes'
import type { PaintedEdit } from './PaintTimes'
import { openPollRpc } from '../lib/samplePoll'
import { MAX_OPTIONS, OPTION_DESCRIPTION_MAX, OPTION_NAME_MAX, tooLong } from '../lib/limits'
import { voterKeyFor } from '../lib/voterKey'
import type { VoterName } from '../lib/voterName'
import { DescriptionField, DescriptionToggle } from './DescriptionField'
import { NameRoster } from './NameRoster'
import { OptionDescription } from './OptionDescription'
import { RollingBadge } from './PollTags'
import { formatDay, parseWindowStart } from '../lib/schedule'
import css from './CollectOptions.module.css'
import listRow from './listRow.module.css'
import { VoterNameField } from './VoterNameField'
import type { PollOption, PollSchedule } from '../lib/types'

/** Unique within one open card; never leaves it. */
let draftSeq = 0

/** `description` is null when its field is hidden, which means no description. */
type OptionText = { name: string; description: string | null }

/** An option this reader is typing and has not sent. */
type Draft = OptionText & { key: string }

/** A new draft opens with its description field showing. */
function blankDraft(): Draft {
  draftSeq += 1
  return { key: `draft-${draftSeq}`, name: '', description: '' }
}

function isBlank(d: Draft): boolean {
  return !d.name.trim() && !d.description?.trim()
}

function fieldsOf(option: PollOption): OptionText {
  return { name: option.name, description: option.description || null }
}

type Focus = { key: string; field: 'name' | 'description' }

/** A validation problem, marked on the field it is about. */
type Problem = { field: 'name' | 'description'; message: string }

/**
 * Which endpoints a list writes through: an invite poll (session), an open
 * poll (link), or the creator correcting a list that is already a ballot.
 */
export type OptionsSource =
  | { kind: 'poll'; pollId: string }
  | { kind: 'open'; pollId: string }
  | { kind: 'creator'; pollId: string }

/**
 * The unsaved edit a list is holding, so the card's closing button (*Confirm
 * options* or *Done*) can save it first: one press, one save. Resolves to
 * whether the save went through; the list reports its own errors. Null when
 * nothing is outstanding.
 */
export type DraftHold = { current: (() => Promise<boolean>) | null }

/**
 * How this reader says they are done adding. Absent for the creator's
 * correction and for an invite poll's creator who did not invite themselves
 * (their equivalent is *Open poll*).
 */
export interface Confirmation {
  confirmed: boolean
  /**
   * Whether this press could open the poll (an invite poll still waiting on
   * somebody). The count itself is the count badge's job.
   */
  opensWhenEveryoneHas?: boolean
}

/**
 * The option-collecting card, laid out like the ballot it precedes. Used for a
 * poll still collecting options (everyone suggests through the same RPC, the
 * creator included) and for the creator correcting a list that is already a
 * ballot (`source.kind === 'creator'`, ending in *Done*).
 *
 * Every edit is a draft until the press that ends the card; see DraftHold and
 * "Confirming is the save" in AGENTS.md. Suggestions carry no name; the name
 * field is the confirmation's.
 */
export function CollectOptions({
  source,
  options,
  schedule,
  isCreator,
  voterName,
  questionStrip,
  done,
  confirm,
  onChanged,
  onConfirmed,
}: {
  source: OptionsSource
  options: PollOption[]
  /** Set on a time poll, which collects by calendar instead of text boxes. */
  schedule?: PollSchedule | null
  isCreator: boolean
  /**
   * The name to confirm under: only an open poll that shows respondents asks.
   * Held by the page so it survives question changes; see VoterNameField.
   */
  voterName?: VoterName
  /** Navigation for a multi-question poll, rendered inside the card as on the ballot. */
  questionStrip?: ReactNode
  /** The creator's way out of a correction: saves the draft, then leaves. */
  done?: {
    note?: ReactNode
    onDone: () => void
  }
  confirm?: Confirmation
  /** An option arrived or left, or a confirmation moved: re-read the poll. */
  onChanged: () => void
  /**
   * A first confirmation went in, so a multi-question poll can move on.
   * Replaces `onChanged` on that path (a re-read of the question being left
   * would land after the next one loaded).
   */
  onConfirmed?: () => void
}) {
  const [busy, setBusy] = useState(false)
  // Request errors; field errors are marked on the fields.
  const [error, setError] = useState<string | null>(null)
  const draft = useRef<(() => Promise<boolean>) | null>(null)
  // Whether this reader has started an edit, as the list last reported it:
  // anything unsaved, and also an editor merely opened (*Add option* pressed,
  // a pencil, the calendar's *Add times*) before anything is typed in it.
  const [dirty, setDirty] = useState(false)
  // What the list is a list of, in the card's own words.
  const noun = schedule ? 'times' : 'options'
  const Noun = schedule ? 'Times' : 'Options'
  // A withdrawal in flight, which a confirmation waits behind.
  const withdrawing = useRef<PromiseLike<unknown> | null>(null)

  // Starting an edit takes a confirmation back, so the reader does not read as
  // done while they are part-way through adding to the list; confirming again
  // saves the edit. See "Saying you are done adding options" in AGENTS.md.
  const confirmed = confirm?.confirmed ?? false
  // The same withdrawal as state, so the button can show it under way: from
  // the moment it is sent until the re-read says unconfirmed.
  const [unconfirming, setUnconfirming] = useState(false)
  useEffect(() => {
    if (!dirty || !confirmed || withdrawing.current) return
    setUnconfirming(true)
    // Held until the re-read says unconfirmed, so it is sent once.
    withdrawing.current = withdrawConfirmation(source).then(({ error: rpcError }) => {
      if (rpcError) {
        setError(rpcError.message)
        setUnconfirming(false)
      } else onChanged()
    })
  }, [dirty, confirmed, source, onChanged])
  useEffect(() => {
    if (confirmed) return
    withdrawing.current = null
    setUnconfirming(false)
  }, [confirmed])

  // Confirmed with nothing unsaved: the button reads *Options confirmed*.
  const settled = confirmed && !dirty
  // Bumped each time it becomes settled while on screen, which re-mounts the
  // tick to pop. Zero on arrival, so a page opened already confirmed is still.
  const [pop, setPop] = useState(0)
  const wasSettled = useRef(settled)
  useEffect(() => {
    if (settled && !wasSettled.current) setPop((n) => n + 1)
    wasSettled.current = settled
  }, [settled])

  // Disabled rather than hidden while confirmed, so the card does not jump.
  const nameField =
    confirm && voterName ? <VoterNameField name={voterName} disabled={confirmed} /> : null

  async function confirmOptions() {
    if (busy || !confirm) return
    setError(null)

    if (voterName && !voterName.check('Enter your name so the group can see who has confirmed.')) {
      return
    }

    setBusy(true)
    // A withdrawal still in flight must land first, or it would undo this.
    await withdrawing.current

    // Save the draft first: it is part of what is being confirmed.
    const save = draft.current
    if (save && !(await save())) {
      setBusy(false)
      return
    }

    const { error: rpcError } = await sendConfirmation(source, voterName?.trimmed ?? null)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      // The draft was saved even though the confirmation failed: re-read.
      if (save) onChanged()
      return
    }
    notifications.show({ message: `${Noun} confirmed`, color: 'green' })
    ;(onConfirmed ?? onChanged)()
  }

  async function finishEditing() {
    if (busy || !done) return
    setError(null)

    const save = draft.current
    if (save) {
      setBusy(true)
      const saved = await save()
      setBusy(false)
      if (!saved) return
      onChanged()
    }
    done.onDone()
  }

  /** The card's foot: its closing button, what happens next, and the list's *Add option*. */
  function footer(addButton: ReactNode, ruled: boolean) {
    return (
      <>
        {error && (
          <Text role="alert" c="red" size="sm">
            {error}
          </Text>
        )}

        {/* A text list rules off its own last row; the calendar does not. */}
        {ruled && (confirm || done) && <Divider />}

        {confirm ? (
          <Group justify="space-between" wrap="wrap" gap="sm" align="flex-end">
            <Text size="sm" c="dimmed">
              {confirm.confirmed && !dirty
                ? `You’ve confirmed the ${noun}`
                : `Confirm the ${noun} once you’re done.`}
              <br />
              {confirm.opensWhenEveryoneHas ? (
                <>The poll opens for voting once everyone confirms.</>
              ) : (
                <>
                  {isCreator
                    ? 'Voting starts once you open the poll.'
                    : 'Voting starts once the poll’s creator opens the poll.'}
                </>
              )}
            </Text>
            <Group gap="xs" wrap="nowrap" style={{ marginLeft: 'auto' }}>
              {addButton}
              {/* One button changing in place, so the change can be seen; see
                  CollectOptions.module.css. */}
              <Button
                className={css.confirm}
                data-confirmed={settled || undefined}
                disabled={settled}
                onClick={confirmOptions}
                loading={busy || unconfirming}
                leftSection={
                  <span key={pop} className={`${css.tick} ${pop ? css.pop : ''}`}>
                    <CheckIcon size={16} aria-hidden />
                  </span>
                }
              >
                {settled ? `${Noun} confirmed` : `Confirm ${noun}`}
              </Button>
            </Group>
          </Group>
        ) : (
          done && (
            <Group justify="space-between" wrap="wrap" gap="sm">
              {done.note && (
                <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
                  {done.note}
                </Text>
              )}
              <Group gap="xs" wrap="nowrap" style={{ marginLeft: 'auto' }}>
                {addButton}
                <Button
                  onClick={finishEditing}
                  loading={busy}
                  leftSection={<CheckIcon size={16} aria-hidden />}
                >
                  Done
                </Button>
              </Group>
            </Group>
          )
        )}
      </>
    )
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        {nameField}
        {questionStrip}

        {schedule ? (
          <>
            <TimeList
              source={source}
              options={options}
              schedule={schedule}
              isCreator={isCreator}
              // Its own save only when the card has no closing button.
              ownSave={!confirm && !done}
              draft={draft}
              footer={footer}
              onDirtyChange={setDirty}
              onChanged={onChanged}
            />
          </>
        ) : (
          <OptionList
            source={source}
            options={options}
            isCreator={isCreator}
            ownSave={!confirm && !done}
            draft={draft}
            footer={footer}
            onDirtyChange={setDirty}
            onChanged={onChanged}
          />
        )}
      </Stack>
    </Card>
  )
}

function sendConfirmation(source: OptionsSource, voterName: string | null) {
  return source.kind === 'poll'
    ? supabase.rpc('confirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_confirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
        p_voter_name: voterName,
      })
}

function withdrawConfirmation(source: OptionsSource) {
  return source.kind === 'poll'
    ? supabase.rpc('unconfirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_unconfirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
      })
}

/** The poll's list and the fields that add to it, apart from this reader's card. */
function OptionList({
  source,
  options,
  isCreator,
  ownSave,
  draft,
  footer,
  onDirtyChange,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  isCreator: boolean
  /** Draw a *Save options* of its own (only when the card has no closing button). */
  ownSave: boolean
  draft: DraftHold
  /** The card's foot, handed the list's *Add option*. Unused when `ownSave`. */
  footer?: (addButton: ReactNode, ruled: boolean) => ReactNode
  /** Told whenever the list starts or stops holding an unsaved edit. */
  onDirtyChange?: (dirty: boolean) => void
  onChanged: () => void
}) {
  // Typed options stay editable fields until the card's closing press; there
  // is deliberately no *Add* that would draw them as if already saved.
  const [shownDrafts, setDrafts] = useState<Draft[]>([])
  // Drafts discarded and still shrinking out (listRow's `leaving`), dropped
  // from state when that ends. Drawn, and counted as nothing else.
  const [discarding, setDiscarding] = useState<ReadonlySet<string>>(new Set())
  const drafts = shownDrafts.filter((d) => !discarding.has(d.key))
  const [draftProblems, setDraftProblems] = useState<ReadonlyMap<string, Problem>>(new Map())
  // The field just asked for, which takes the cursor.
  const [focus, setFocus] = useState<Focus | null>(null)
  // Rows opened by their pencil, by option id. A correction is sent as an
  // update in place (`p_correct`), so the option keeps its id and its scores.
  // A row opened and left unchanged is not sent.
  const [editing, setEditing] = useState<ReadonlyMap<string, OptionText>>(new Map())
  const [editProblems, setEditProblems] = useState<ReadonlyMap<string, Problem>>(new Map())
  // Rows struck out, by id. A struck open row keeps its typed fields for *Keep*.
  const [dropping, setDropping] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const arriving = useArrivals(options)

  const filled = drafts.filter((d) => !isBlank(d))
  const changed = options.filter((o) => {
    const e = editing.get(o.id)
    return (
      e &&
      !dropping.has(o.id) &&
      (e.name.trim() !== o.name || (e.description ?? '').trim() !== (o.description ?? ''))
    )
  })
  const staying = options.length - dropping.size
  const kept = staying + filled.length
  const full = kept >= MAX_OPTIONS
  const dirty = filled.length > 0 || dropping.size > 0 || changed.length > 0
  // An edit under way, typed into or not: a field opened by *Add option* or a
  // pencil is enough to take a confirmation back.
  const started = dirty || drafts.length > 0 || editing.size > 0
  // No two-option floor here: `creator_edit_options` enforces it on save.

  /**
   * Names the saved list would hold, except row `exceptKey`. Open rows count
   * as what is typed in them; struck rows still count, so a name the list
   * visibly holds stays taken.
   */
  function namesInUse(exceptKey?: string): string[] {
    const nameOf = (o: PollOption) => editing.get(o.id)?.name.trim() ?? o.name

    // Only drafts above this one, so a duplicate marks the later draft.
    const draftAt = drafts.findIndex((d) => d.key === exceptKey)
    const above = draftAt === -1 ? drafts : drafts.slice(0, draftAt)

    return [
      ...options.filter((o) => o.id !== exceptKey).map(nameOf),
      ...above.filter((d) => !isBlank(d)).map((d) => d.name.trim()),
    ]
  }

  /**
   * `insert_option`'s rules, checked client-side so the failing field can be
   * marked. The database still decides. `adding` is the list size with this
   * option added, or false for a correction (which cannot hit the ceiling).
   */
  function checkOption(
    rawName: string,
    rawDescription: string,
    { adding, exceptKey }: { adding: number | false; exceptKey?: string },
  ): { name: string; description: string } | Problem {
    const trimmed = rawName.trim()
    const trimmedDescription = rawDescription.trim()

    if (!trimmed) return { field: 'name', message: 'Give the option a name.' }
    if (trimmed.length > OPTION_NAME_MAX)
      return { field: 'name', message: tooLong('An option name', trimmed.length, OPTION_NAME_MAX) }
    // Case-insensitive, like the database.
    if (namesInUse(exceptKey).some((existing) => existing.toLowerCase() === trimmed.toLowerCase()))
      return { field: 'name', message: `“${trimmed}” is already on the list.` }
    if (trimmedDescription.length > OPTION_DESCRIPTION_MAX)
      return {
        field: 'description',
        message: tooLong('A description', trimmedDescription.length, OPTION_DESCRIPTION_MAX),
      }
    if (adding !== false && adding > MAX_OPTIONS)
      return {
        field: 'name',
        message: `This poll already holds the ${MAX_OPTIONS} options a ballot can.`,
      }

    return { name: trimmed, description: trimmedDescription }
  }

  /** Every draft and correction, checked; null (with every problem marked) if any fail. */
  function checkedDraft(): {
    added: { name: string; description: string }[]
    corrected: { key: string; name: string; description: string }[]
  } | null {
    setError(null)

    const addProblems = new Map<string, Problem>()
    const added: { name: string; description: string }[] = []
    for (const d of drafts) {
      if (isBlank(d)) continue
      const result = checkOption(d.name, d.description ?? '', {
        adding: staying + added.length + addProblems.size + 1,
        exceptKey: d.key,
      })
      if ('field' in result) addProblems.set(d.key, result)
      else added.push(result)
    }

    const fixProblems = new Map<string, Problem>()
    const corrected: { key: string; name: string; description: string }[] = []
    for (const o of changed) {
      const e = editing.get(o.id)!
      const result = checkOption(e.name, e.description ?? '', { adding: false, exceptKey: o.id })
      if ('field' in result) fixProblems.set(o.id, result)
      else corrected.push({ key: o.id, ...result })
    }

    setDraftProblems(addProblems)
    setEditProblems(fixProblems)
    return addProblems.size > 0 || fixProblems.size > 0 ? null : { added, corrected }
  }

  function changeDraft(key: string, fields: Partial<Omit<Draft, 'key'>>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...fields } : d)))
    setDraftProblems((prev) => without(prev, key))
  }

  function addDraft() {
    const next = blankDraft()
    setDrafts((prev) => [...prev, next])
    setFocus({ key: next.key, field: 'name' })
  }

  function discardDraft(key: string) {
    setDiscarding((prev) => new Set(prev).add(key))
    setDraftProblems((prev) => without(prev, key))
  }

  /** The discarded row has finished shrinking: now it can go. */
  function discarded(key: string) {
    setDrafts((prev) => prev.filter((d) => d.key !== key))
    setDiscarding((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  function openEditor(option: PollOption) {
    setEditing((prev) => new Map(prev).set(option.id, fieldsOf(option)))
    setFocus({ key: option.id, field: 'name' })
  }

  function changeEdit(id: string, fields: OptionText) {
    setEditing((prev) => new Map(prev).set(id, fields))
    setEditProblems((prev) => without(prev, id))
  }

  function toggleDescription(key: string, fields: OptionText, change: (f: OptionText) => void) {
    const opening = fields.description === null
    change({ ...fields, description: opening ? '' : null })
    if (opening) setFocus({ key, field: 'description' })
  }

  function toggleDropping(id: string) {
    setDropping((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setEditProblems((prev) => without(prev, id))
  }

  /** Save the whole draft in one press. A refusal leaves the draft intact. */
  async function saveEverything(): Promise<boolean> {
    if (busy) return false
    const checked = checkedDraft()
    if (!checked) return false
    const { added, corrected } = checked

    // Nothing to send still closes what was opened: blank fields, and rows
    // opened by their pencil and left as they were.
    if (added.length > 0 || corrected.length > 0 || dropping.size > 0) {
      setError(null)
      setBusy(true)
      const { error: rpcError } = await sendDraft(source, {
        added,
        corrected: corrected.map(({ key, name, description }) => ({ id: key, name, description })),
        removed: [...dropping],
      })
      setBusy(false)

      if (rpcError) {
        setError(rpcError.message)
        return false
      }
    }
    setDrafts([])
    setDiscarding(new Set())
    setDraftProblems(new Map())
    setDropping(new Set())
    setEditing(new Map())
    setEditProblems(new Map())
    // Silent: the closing press that called this notifies and re-reads.
    // `saveOwn` does both for itself.
    return true
  }

  async function saveOwn() {
    if (!(await saveEverything())) return
    notifications.show({ message: 'Options saved', color: 'green' })
    onChanged()
  }

  useEffect(() => {
    onDirtyChange?.(started)
  }, [started, onDirtyChange])

  // Re-registered every render so it closes over the current draft. Held while
  // anything is open, so the closing press also closes an empty field.
  useEffect(() => {
    draft.current = started ? () => saveEverything() : null

    return () => {
      draft.current = null
    }
  })

  const addButton = (
    <Button
      variant="light"
      onClick={addDraft}
      disabled={full || busy}
      leftSection={<PlusIcon size={16} aria-hidden />}
    >
      Add option
    </Button>
  )

  return (
    // Out of the page's SmoothHeight: a row joining grows itself in
    // (listRow.module.css), and the page clipping the card to the height it
    // had measured with the row still at nothing hid the buttons under it
    // until its own animation ran out.
    <Stack gap="sm" data-own-height>
      {options.map((option) => {
        const struck = dropping.has(option.id)
        const open = editing.get(option.id)
        const shown = open ?? fieldsOf(option)

        return (
          <div
            key={option.id}
            className={`${listRow.row} ${arriving.has(option.id) ? listRow.joining : ''}`}
          >
            <div className={`${listRow.content} ${listRow.stacked}`}>
              <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
                {open && !struck ? (
                  <OptionFields
                    value={open}
                    problem={editProblems.get(option.id) ?? null}
                    focus={focus?.key === option.id ? focus.field : undefined}
                    ariaLabel={`Name of ${option.name}`}
                    onChange={(fields) => changeEdit(option.id, fields)}
                  />
                ) : (
                  <div style={{ minWidth: 0 }}>
                    <Text
                      fw={500}
                      c={struck ? 'dimmed' : undefined}
                      td={struck ? 'line-through' : undefined}
                    >
                      {shown.name}
                    </Text>
                    {shown.description && (
                      <OptionDescription description={shown.description} struck={struck} />
                    )}
                  </div>
                )}
                {isCreator &&
                  (struck ? (
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      onClick={() => toggleDropping(option.id)}
                      leftSection={<ArrowCounterClockwiseIcon size={14} aria-hidden />}
                    >
                      Keep
                    </Button>
                  ) : (
                    <Group gap={4} wrap="nowrap" mt={open ? 6 : 0}>
                      {/* Once open, the pencil gives way to the description toggle. */}
                      {open ? (
                        <DescriptionToggle
                          open={open.description !== null}
                          subject={option.name}
                          onToggle={() =>
                            toggleDescription(option.id, open, (f) => changeEdit(option.id, f))
                          }
                        />
                      ) : (
                        <ActionIcon
                          variant="subtle"
                          aria-label={`Edit ${option.name}`}
                          onClick={() => openEditor(option)}
                        >
                          <PencilSimpleIcon size={16} aria-hidden />
                        </ActionIcon>
                      )}
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Remove ${option.name}`}
                        onClick={() => toggleDropping(option.id)}
                      >
                        &times;
                      </ActionIcon>
                    </Group>
                  ))}
              </Group>
              <Divider />
            </div>
          </div>
        )
      })}

      {options.length === 0 && shownDrafts.length === 0 && (
        <Text size="sm" c="dimmed">
          Nothing suggested yet.
        </Text>
      )}

      {shownDrafts.map((d, i) => (
        <div
          key={d.key}
          className={`${listRow.row} ${discarding.has(d.key) ? listRow.leaving : listRow.joining}`}
          // Its own animation only, not one bubbling up from inside the row.
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget && discarding.has(d.key)) discarded(d.key)
          }}
          inert={discarding.has(d.key) || undefined}
        >
          <div className={`${listRow.content} ${listRow.stacked}`}>
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <OptionFields
                value={d}
                problem={draftProblems.get(d.key) ?? null}
                focus={focus?.key === d.key ? focus.field : undefined}
                placeholder={
                  options.length === 0 && i === 0 ? 'Add an option' : 'Add another option'
                }
                ariaLabel="Option you are suggesting"
                onChange={(fields) => changeDraft(d.key, fields)}
              />
              <Group gap={4} wrap="nowrap" mt={6}>
                <DescriptionToggle
                  open={d.description !== null}
                  subject={d.name.trim() || 'this option'}
                  onToggle={() => toggleDescription(d.key, d, (f) => changeDraft(d.key, f))}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Discard ${d.name.trim() || 'this option'}`}
                  onClick={() => discardDraft(d.key)}
                >
                  &times;
                </ActionIcon>
              </Group>
            </Group>
            <Divider />
          </div>
        </div>
      ))}

      {full && (
        <Text size="xs" c="dimmed">
          A ballot may only have {MAX_OPTIONS} options.
        </Text>
      )}

      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}

      {ownSave ? (
        <Group justify="flex-end" gap="xs">
          {addButton}
          <Button
            onClick={saveOwn}
            loading={busy}
            disabled={!dirty}
            leftSection={<CheckIcon size={16} aria-hidden />}
          >
            Save options
          </Button>
        </Group>
      ) : (
        // With no rows to rule it off, the foot draws its own line.
        footer?.(addButton, options.length === 0 && shownDrafts.length === 0)
      )}
    </Stack>
  )
}

function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

/**
 * Send a draft. The creator's correction is one `creator_edit_options`. A
 * list still collecting is two calls, because two parties write it:
 * corrections and removals through the creator's door first (freeing names
 * and room under the ceiling), then suggestions through the endpoint everyone
 * shares. The plural suggestion endpoints skip names already on the list.
 */
function sendDraft(
  source: OptionsSource,
  draft: {
    added: { name: string; description: string }[]
    corrected: { id: string; name: string; description: string }[]
    removed: string[]
  },
) {
  // Null, not '', is what the column holds for no description.
  const named = (options: { name: string; description: string }[]) =>
    options.map((o) => ({ name: o.name, description: o.description || null }))
  const corrected = draft.corrected.map((o) => ({ id: o.id, ...named([o])[0] }))

  if (source.kind === 'creator')
    return supabase.rpc('creator_edit_options', {
      p_poll_id: source.pollId,
      p_options: named(draft.added),
      p_remove: draft.removed,
      p_correct: corrected,
    })

  return applyToCollecting(source, {
    corrected,
    removed: draft.removed,
    added: named(draft.added),
  })
}

async function applyToCollecting(
  source: Exclude<OptionsSource, { kind: 'creator' }>,
  draft: {
    corrected: { id: string; name: string; description: string | null }[]
    removed: string[]
    added: { name: string; description: string | null }[]
  },
) {
  if (draft.corrected.length > 0 || draft.removed.length > 0) {
    const { error } = await supabase.rpc('creator_edit_options', {
      p_poll_id: source.pollId,
      p_remove: draft.removed,
      p_correct: draft.corrected,
    })
    if (error) return { error }
  }

  if (draft.added.length === 0) return { error: null }

  const body = { p_poll_id: source.pollId, p_options: draft.added }
  return source.kind === 'poll'
    ? supabase.rpc('suggest_options', body)
    : supabase.rpc('open_poll_suggest_options', body)
}

/** One option's two fields, controlled: a draft, or a row opened by its pencil. */
function OptionFields({
  value,
  problem,
  focus,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value: OptionText
  problem: Problem | null
  /** Which field takes the cursor on mount. */
  focus?: 'name' | 'description'
  placeholder?: string
  ariaLabel: string
  onChange: (value: OptionText) => void
}) {
  return (
    <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
      <TextInput
        value={value.name}
        autoFocus={focus === 'name'}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange({ ...value, name: e.currentTarget.value })}
        error={problem?.field === 'name' ? problem.message : null}
      />
      {value.description !== null && (
        <DescriptionField
          value={value.description}
          autoFocus={focus === 'description'}
          onChange={(e) => onChange({ ...value, description: e.currentTarget.value })}
          placeholder="Optional description"
          error={problem?.field === 'description' ? problem.message : null}
        />
      )}
    </Stack>
  )
}

/** The list on a time poll: painted on a calendar (`PaintTimes`), saved in one request. */
function TimeList({
  source,
  options,
  schedule,
  isCreator,
  ownSave,
  draft,
  footer,
  onDirtyChange,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  schedule: PollSchedule
  isCreator: boolean
  ownSave: boolean
  draft: DraftHold
  /** The card's foot, handed the calendar's *Add times*. */
  footer: (addButton: ReactNode, ruled: boolean) => ReactNode
  onDirtyChange: (dirty: boolean) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The painting's difference from the list, as PaintTimes last reported it.
  const [painted, setPainted] = useState<PaintedEdit | null>(null)
  // No calendar until *Add times* is pressed, only a line saying what the
  // list holds (`TimesSummary`): a calendar that looked paintable and was not
  // read as broken. The creator's correction is already an editor, opened from
  // *Edit options*, so it starts editing.
  const [editing, setEditing] = useState(source.kind === 'creator')
  // Opening the calendar is starting an edit, as opening a text field is.
  const started = painted !== null || (editing && source.kind !== 'creator')

  const noteDraft = useCallback((edit: PaintedEdit | null) => {
    setPainted(edit)
  }, [])

  async function save(add: string[], removeIds: string[], quiet = false): Promise<boolean> {
    if (busy) return false
    // Nothing painted: only the calendar to close.
    if (add.length === 0 && removeIds.length === 0) return landed(add, removeIds, quiet)
    setError(null)
    setBusy(true)

    // One call, so the two-option floor is checked where the edit lands.
    if (source.kind === 'creator') {
      const { error: rpcError } = await supabase.rpc('creator_edit_options', {
        p_poll_id: source.pollId,
        p_options: add.map((name) => ({ name })),
        p_remove: removeIds,
      })
      setBusy(false)

      if (rpcError) {
        setError(rpcError.message)
        return false
      }
      return landed(add, removeIds, quiet)
    }

    // Removals first, so a swap cannot trip the option ceiling midway.
    if (removeIds.length > 0) {
      const { error: deleteError } = await supabase.from('candidates').delete().in('id', removeIds)
      if (deleteError) {
        setBusy(false)
        setError(deleteError.message)
        return false
      }
    }

    const { error: rpcError } = add.length === 0 ? { error: null } : await sendTimes(source, add)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return false
    }

    return landed(add, removeIds, quiet)
  }

  /** `quiet` saves are part of a closing press, which notifies and re-reads itself. */
  function landed(add: string[], removeIds: string[], quiet: boolean) {
    if (source.kind !== 'creator') {
      // The calendar goes, and the next one opens on the list as it then is.
      setEditing(false)
      setPainted(null)
    }
    if (quiet) return true

    notifications.show({
      message:
        add.length > 0
          ? `Added ${add.length} ${add.length === 1 ? 'time' : 'times'}`
          : `Removed ${removeIds.length} ${removeIds.length === 1 ? 'time' : 'times'}`,
      color: 'green',
    })
    onChanged()
    return true
  }

  useEffect(() => {
    onDirtyChange(started)
  }, [started, onDirtyChange])

  // Re-registered every render; see DraftHold. Held while the calendar is
  // open, so the closing press also closes one with nothing painted on it.
  useEffect(() => {
    draft.current = started ? () => save(painted?.add ?? [], painted?.removeIds ?? [], true) : null

    return () => {
      draft.current = null
    }
  })

  const addButton = (
    <Button
      variant="light"
      onClick={() => setEditing(true)}
      disabled={editing || busy}
      leftSection={
        isCreator ? <PencilSimpleIcon size={16} aria-hidden /> : <PlusIcon size={16} aria-hidden />
      }
    >
      {/* A creator's gestures take times off as well as putting them on. */}
      {isCreator ? 'Edit times' : 'Add times'}
    </Button>
  )

  return (
    <Stack gap="sm">
      {editing ? (
        <PaintTimes
          schedule={schedule}
          options={options}
          canRemove={isCreator}
          saving={busy}
          showSave={ownSave}
          onSave={save}
          onDraftChange={noteDraft}
        />
      ) : (
        <TimesSummary options={options} />
      )}
      {error && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}
      {/* With no closing button on the card, the calendar's own *Save times*
          stands in for the foot once editing; before that, *Add times* does. */}
      {ownSave
        ? !editing && <Group justify="flex-end">{addButton}</Group>
        : footer(source.kind === 'creator' ? null : addButton, true)}
    </Stack>
  )
}

/**
 * What a time poll's list holds, before anybody opens the calendar: how many
 * windows, and the first and last day they fall on. Badges, because the list
 * moves while it is read (somebody else's suggestion landing), and a badge
 * whose words roll over shows that it did; see RollingBadge.
 */
function TimesSummary({ options }: { options: PollOption[] }) {
  const days = options
    .map((o) => parseWindowStart(o.name)?.day)
    .filter((day) => day !== undefined)
    .sort()

  if (days.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No times suggested yet.
      </Text>
    )
  }

  const first = days[0]
  const last = days[days.length - 1]
  return (
    <Group gap={6} wrap="wrap">
      <RollingBadge
        label={`${options.length} ${options.length === 1 ? 'time option' : 'time options'}`}
      />
      {/* The range is one item of the row, so a narrow card moves it onto a
          line of its own whole rather than breaking it after "from X to";
          it only wraps inside itself where even a line of its own is too
          narrow. */}
      <Group gap={6} wrap="wrap">
        {first === last ? (
          <>
            <Text size="sm" span>
              on
            </Text>
            <RollingBadge label={formatDay(first)} />
          </>
        ) : (
          <>
            <Text size="sm" span>
              from
            </Text>
            <RollingBadge label={formatDay(first)} />
            <Text size="sm" span>
              to
            </Text>
            <RollingBadge label={formatDay(last)} />
          </>
        )}
      </Group>
    </Group>
  )
}

/** A painting's windows in one request, so a run cannot stop half-inserted. */
function sendTimes(source: Exclude<OptionsSource, { kind: 'creator' }>, names: string[]) {
  const body = { p_options: names.map((name) => ({ name })) }
  if (source.kind === 'poll')
    return supabase.rpc('suggest_options', { p_poll_id: source.pollId, ...body })
  return supabase.rpc('open_poll_suggest_options', { p_poll_id: source.pollId, ...body })
}

/**
 * Who has confirmed, on an open poll that names respondents. Invite polls show
 * this on the `Respondents` card instead.
 */
export function Confirmations({ names }: { names: string[] }) {
  return (
    <NameRoster
      title="Confirmed the options"
      names={names}
      empty="Nobody has confirmed the options yet."
    />
  )
}

/**
 * Options that arrived since the last read (e.g. from another voter), to
 * animate in. Nothing counts as new on the first read. Set from an effect, so
 * the class lands a frame after the row and has something to animate from.
 */
function useArrivals(options: PollOption[]): ReadonlySet<string> {
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set())
  // Null until the first read.
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    const ids = options.map((option) => option.id)
    const before = seen.current
    seen.current = new Set(ids)
    if (!before) return

    const added = ids.filter((id) => !before.has(id))
    if (added.length) setArriving(new Set(added))
  }, [options])

  return arriving
}
