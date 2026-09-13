import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ActionIcon,
  Button,
  Card,
  Divider,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { PencilSimpleIcon } from '@phosphor-icons/react'
import { notifications } from '@mantine/notifications'
import { supabase } from '../lib/supabase'
import { PaintTimes } from './PaintTimes'
import type { PaintedEdit } from './PaintTimes'
import { openPollRpc } from '../lib/samplePoll'
import { MAX_OPTIONS, OPTION_DESCRIPTION_MAX, OPTION_NAME_MAX, tooLong } from '../lib/limits'
import { voterKeyFor } from '../lib/voterKey'
import type { VoterName } from '../lib/voterName'
import { DescriptionField } from './DescriptionField'
import { NameRoster } from './NameRoster'
import { OptionDescription } from './OptionDescription'
import listRow from './listRow.module.css'
import { OpeningNote } from './PollNotices'
import { VoterNameField } from './VoterNameField'
import type { PollOption, PollSchedule } from '../lib/types'

/**
 * Which endpoint an added option goes through.
 *
 * The first two are the suggestion path, and are the same split as
 * ResultsSource and BallotsSource for the same reason: a session proves the
 * caller belongs to an invite poll, the link proves it for an open
 * one. `creator` is the other path entirely; the poll's own creator
 * correcting a list that is already a ballot, on a poll nobody has voted in
 * yet. See 0028_creator_edits_options.sql for why that is allowed and where
 * the window closes.
 *
 * Confirming takes the same two ways in, so it takes the same value: the
 * creator's correction is the one that cannot be confirmed, because a list
 * that is already a ballot has nobody left to be done adding to it.
 */
/** Only has to be unique within one open card, and never leaves it. */
let draftSeq = 0

/**
 * What is wrong with an option somebody has typed, and which of its two
 * fields it is wrong in -- so the message lands on that field rather than as
 * a line of red under the whole card.
 */
type Problem = { field: 'name' | 'description'; message: string }

export type OptionsSource =
  | { kind: 'poll'; pollId: string }
  | { kind: 'open'; pollId: string }
  | { kind: 'creator'; pollId: string }

/**
 * The unsaved edit a list is holding, left where the card around it can apply
 * it.
 *
 * Confirming the options is one act -- *this list, the one in front of me, is
 * the one I mean* -- and it used to be two: save the windows you painted, or
 * add the option you typed, and then say you were done with the list they
 * went into. So the list writes what it is holding into this hole, and
 * *Confirm options* puts it in before it confirms anything. It answers
 * whether the save went through; the list has already said what was wrong
 * with it, against the field or under the list, where the reader was looking.
 *
 * Null whenever there is nothing outstanding, which is what makes a
 * confirmation with no edits behind it a single request as it always was.
 */
export type DraftHold = { current: (() => Promise<boolean>) | null }

/**
 * How this reader says they are done with the list, when they have a say in
 * it at all. Absent for the creator correcting a ballot's options, and for an
 * invite poll's creator who did not invite themselves — their "I am done" is
 * *Open poll*, which they have had all along.
 */
export interface Confirmation {
  /** Whether they have already said so; the card draws either way. */
  confirmed: boolean
  /**
   * Whether this press could be the press that opens the poll — a poll with a
   * participant list, still waiting on somebody. The one thing about the
   * button that is not obvious from the button.
   *
   * **How many have confirmed is deliberately not here**; that is the count
   * badge's job. It is false once everybody has confirmed, which is a poll
   * that stayed put for a reason this card cannot name — a question of the
   * group nobody has finished, or a list still short of two options — so it
   * says the creator ends the stage rather than promising an opening that has
   * already not happened.
   */
  opensWhenEveryoneHas?: boolean
}

/**
 * The option-collecting stage as one person sees it, laid out as the ballot
 * that replaces it: name at the top, the poll's other questions under it, the
 * thing being filled in, and what happens next beside the button that ends
 * your part in it.
 *
 * Collecting options is the ballot's stage, at the same address and in the
 * same place on the page, so the two cards are built the same way round rather
 * than each in whatever order it grew in.
 *
 * It stands in for the ballot on two occasions, and they are not the same:
 *
 *  - a poll **still collecting** its options, which has no ballot yet.
 *    Everyone in the poll sees this list and this box, the creator included,
 *    who suggests through the same RPC as everybody else — one code path, and
 *    no way for the creator's list to be built under rules nobody else's is.
 *  - a poll whose creator is **correcting** a list that is already a ballot,
 *    which only they see and only while nobody has voted. That path is
 *    `source.kind === 'creator'`. It confirms nothing and carries its own way
 *    out, as `footer`.
 *
 * Suggestions carry no name: who suggested what would be a third disclosure
 * question on top of "who responded" and "how they voted", and the poll's tags
 * answer neither about the option list. The name field at the top is the
 * *confirmation's*, on the one poll with no account to read one from.
 *
 * Pruning is creator-only and sits beside the list it acts on. Opening the
 * poll does not: that is what the creator does to the *poll*, so it lives in
 * `CreatorControls` with the rest of the lifecycle.
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
  /**
   * The grid, on a poll that finds a time; null on every other poll.
   *
   * Its presence is what swaps the text box and the row-per-suggestion for a
   * calendar: the list a time poll is collecting is a list of window starts,
   * and nobody types one of those. Everything around it -- the name field, the
   * question strip, the confirmation, the roster -- is the same card either
   * way, because being done adding is the same act whichever the list is.
   */
  schedule?: PollSchedule | null
  isCreator: boolean
  /**
   * The name to confirm under, when the poll has to ask for one: an open poll
   * that shows its respondents, and nothing else. `open_poll_confirm_options`
   * applies exactly this rule and discards a name on a poll that hides them,
   * so an invite poll — which reads the name off the account — is handed
   * none and draws no field. Held by the page rather than here; see
   * VoterNameField for why the name outlives the card asking for it.
   */
  voterName?: VoterName
  /** Navigation for a multi-question poll, rendered inside the card as on the ballot. */
  questionStrip?: ReactNode
  /**
   * The way out of the creator's correction, on the one path with nothing to
   * confirm.
   *
   * One press, as *Confirm options* is on every other path: whatever the list
   * is holding goes in, and only a save that went through leaves the editor.
   * It used to be two buttons -- *Save changes* and then *Done* -- for what is
   * one intention, and a reader who pressed only the second lost the edit. See
   * DraftHold.
   */
  done?: {
    /** Said beside the button; the page's situation rather than the list's. */
    note?: ReactNode
    /** Leave the editor, once there is nothing outstanding to leave behind. */
    onDone: () => void
  }
  /** How this reader says they are done adding; see `Confirmation`. */
  confirm?: Confirmation
  /** An option arrived or left, or a confirmation moved: re-read the poll. */
  onChanged: () => void
  /**
   * A *first* confirmation went in, as against one taken back. Offered so a
   * poll of several questions can move on to the next list this reader still
   * owes, which is the whole of what they do next — exactly as a first ballot
   * moves them on. It **replaces** `onChanged` on that path: the page that
   * takes this is leaving the question, and a re-read of the question being
   * left would land after the next one had loaded.
   */
  onConfirmed?: () => void
}) {
  const [busy, setBusy] = useState(false)
  // A request that failed, which is about the poll rather than about the
  // field: what is wrong with the name is marked on the box it was typed in,
  // by the field itself.
  const [error, setError] = useState<string | null>(null)
  // And what to do about it when this reader says they are done. See
  // DraftHold: the list fills it in, `confirmOptions` empties it.
  const draft = useRef<(() => Promise<boolean>) | null>(null)

  // The name is what a confirmation is given under, so it is asked for only
  // where there is something to confirm: the creator correcting a ballot's
  // options confirms nothing and is handed no name to do it under.
  const nameField = confirm && voterName ? <VoterNameField name={voterName} /> : null

  async function confirmOptions() {
    if (busy || !confirm) return
    setError(null)

    if (voterName && !voterName.check('Enter your name so the group can see who has confirmed.')) {
      return
    }

    setBusy(true)

    // Whatever the list is holding goes in first, because that is what is
    // being confirmed: an afternoon painted on the calendar, or an option
    // typed into the box and not yet added, is part of the list this reader
    // is saying they are happy with. Saving it and then saying so were two
    // presses of two buttons for one intention, and the intention is the
    // button. The list reports its own failure, so this only has to stop.
    const save = draft.current
    if (save && !(await save())) {
      setBusy(false)
      return
    }

    const { error: rpcError } = await sendConfirmation(source, voterName?.trimmed ?? null)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    // Remembered only once a confirmation has actually gone in under it, so a
    // name the server refused is not offered back on the next poll.
    voterName?.remember()
    notifications.show({ message: 'Options confirmed', color: 'green' })
    ;(onConfirmed ?? onChanged)()
  }

  /**
   * The way out of the creator's correction: put in whatever the list is
   * holding, and leave only if it went in.
   *
   * The same shape as `confirmOptions`, and for the same reason -- an option
   * typed into the box, or an afternoon painted on the calendar, is part of
   * the list this reader means. The list reports its own failure, so a save
   * that did not go through only has to keep the editor open, with the edit
   * still in it.
   */
  async function finishEditing() {
    if (busy || !done) return
    setError(null)

    const save = draft.current
    if (save) {
      setBusy(true)
      const saved = await save()
      setBusy(false)
      if (!saved) return
      // The quiet save says nothing and re-reads nothing; the page behind this
      // editor is about to draw the list that was just saved.
      onChanged()
    }
    done.onDone()
  }

  async function reopenList() {
    if (busy) return
    setError(null)
    setBusy(true)
    const { error: rpcError } = await withdrawConfirmation(source)
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    // No notification: the card in front of them becoming the list again is
    // the whole of what happened, and says so better than a message would.
    onChanged()
  }

  // Done adding, and back to the list whenever they are not. The same pair as
  // the ballot's "your vote is in" and the *Edit vote* behind it, and the same
  // window: a confirmation can be taken back for exactly as long as it can be
  // given, which is for as long as the poll is still collecting. The database
  // draws that line in `assert_collecting_options`; this card is only ever
  // rendered inside it.
  if (confirm?.confirmed) {
    return (
      <Card withBorder>
        <Stack gap="sm">
          {questionStrip}
          <Stack gap={2}>
            <Text fw={500}>You’ve confirmed the options</Text>
            <Group justify="space-between" wrap="wrap" gap="sm">
              <OpeningNote
                isCreator={isCreator}
                whenEveryoneHas={confirm.opensWhenEveryoneHas}
                canAdd
              />
              <Button
                variant="light"
                onClick={reopenList}
                loading={busy}
                style={{ marginLeft: 'auto' }}
              >
                Edit options
              </Button>
            </Group>
            {error && (
              <Text c="red" size="sm">
                {error}
              </Text>
            )}
          </Stack>
        </Stack>
      </Card>
    )
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        {nameField}
        {questionStrip}

        {schedule ? (
          <TimeList
            source={source}
            options={options}
            schedule={schedule}
            isCreator={isCreator}
            // Wherever this card ends in a button -- *Confirm options*, or
            // the *Done* that leaves a correction -- that button is the save;
            // see DraftHold. The calendar keeps a save of its own only where
            // the card ends in neither, which is the creator of a soliciting
            // poll who did not invite themselves, because there it is the
            // only way the painting reaches the poll at all.
            ownSave={!confirm && !done}
            draft={draft}
            onChanged={onChanged}
          />
        ) : (
          <OptionList
            source={source}
            options={options}
            isCreator={isCreator}
            draft={draft}
            onChanged={onChanged}
          />
        )}

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}

        {/* The line is what stops *Add* and the button that ends the card
            reading as one row: they are the two things this card is for, and
            one adds to a list while the other says you are finished with it.
            The ballot rules its footer off the same way, off the last
            option's divider. */}
        {(confirm || done) && <Divider />}

        {confirm ? (
          <Group justify="space-between" wrap="wrap" gap="sm" align="flex-end">
            <Text size="sm" c="dimmed">
              Confirm the options once you have nothing more to add.
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
            <Button onClick={confirmOptions} loading={busy} style={{ marginLeft: 'auto' }}>
              Confirm options
            </Button>
          </Group>
        ) : (
          done && (
            <Group justify="space-between" wrap="wrap" gap="sm">
              {done.note && (
                <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
                  {done.note}
                </Text>
              )}
              <Button
                variant="light"
                onClick={finishEditing}
                loading={busy}
                style={{ marginLeft: 'auto' }}
              >
                Done
              </Button>
            </Group>
          )
        )}
      </Stack>
    </Card>
  )
}

/** Saying you are done, by whichever of the two identities the poll has. */
function sendConfirmation(source: OptionsSource, voterName: string | null) {
  return source.kind === 'poll'
    ? supabase.rpc('confirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_confirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
        p_voter_name: voterName,
      })
}

/** And taking it back, which the same two functions allow on the same terms. */
function withdrawConfirmation(source: OptionsSource) {
  return source.kind === 'poll'
    ? supabase.rpc('unconfirm_options', { p_poll_id: source.pollId })
    : openPollRpc('open_poll_unconfirm_options', {
        p_poll_id: source.pollId,
        p_voter_key: voterKeyFor(source.pollId),
      })
}

/**
 * The list itself, and the box that adds to it.
 *
 * Split from the card around it because they answer to different people: this
 * is the poll's list, which everybody in the poll writes, and the card is one
 * reader's part in it. Keeping the two apart is also what keeps a suggestion
 * being typed clear of the name a confirmation is given under — two fields,
 * two states, two things that can be wrong, and no way for one to clear the
 * other's message.
 */
function OptionList({
  source,
  options,
  isCreator,
  draft,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  isCreator: boolean
  /**
   * Where the edit this list is holding goes: *Confirm options* on the
   * suggestion paths, *Done* on the creator's correction, and those are the
   * only two paths that draft anything. See DraftHold -- this list has no
   * save button of its own, because on every path that can hold a draft the
   * way out of the card is the save.
   */
  draft: DraftHold
  onChanged: () => void
}) {
  /**
   * Whether *Add* puts the option on the list or into a draft of one.
   *
   * The two suggestion paths add straight away, and should: the list belongs
   * to the group, everybody watching sees a suggestion land as it lands, and
   * that is half of what the collecting stage is for.
   *
   * The creator's correction is nobody else's business and is usually several
   * options at once, so it drafts and saves in one request -- through
   * `creator_add_options`, which is the same door a painted calendar comes in
   * by. Four corrections used to be four round trips and four re-reads of the
   * poll.
   */
  const drafting = source.kind === 'creator'

  const [pending, setPending] = useState<{ key: string; name: string; description: string }[]>([])
  /**
   * Corrections to rows already on the poll, by id, held exactly as the
   * additions and removals beside them are: one press of the way out of the
   * card is one request.
   *
   * A correction travels as a removal and an addition -- there is no update
   * door into `candidates`, and `creator_edit_options` applies its removals
   * before its additions, so a row keeping its name through an edit does not
   * collide with itself. The one visible cost is that the corrected option
   * arrives at the end of the list, where an added option goes.
   */
  const [edits, setEdits] = useState<ReadonlyMap<string, { name: string; description: string }>>(
    new Map(),
  )
  /**
   * The row whose fields are open, keyed by option id or by draft key, and
   * what is in them.
   *
   * One at a time: two rows open at once is two half-made corrections and a
   * reader wondering which of them the way out of the card is about.
   *
   * Held here rather than inside the editor because it is part of the list
   * this reader means, exactly as the box at the foot of the list is -- a
   * correction typed and not saved goes in when *Done* does. See DraftHold.
   */
  const [editing, setEditing] = useState<{ key: string; name: string; description: string } | null>(
    null,
  )
  /** What is wrong with it, on the field it is wrong in. */
  const [editProblem, setEditProblem] = useState<Problem | null>(null)
  // Rows on their way off the list, by id. Held rather than deleted for the
  // reason the additions are held: one press of Save is one request, and a
  // card where adding waits and removing does not is a card that has to be
  // explained.
  const [dropping, setDropping] = useState<ReadonlySet<string>>(new Set())
  const [name, setName] = useState('')
  // Always on screen here, unlike the create form, where a `+` opens one per
  // row: that form shows a dozen option rows at once and a field under each
  // would bury the list, while this box is one option at a time. So there is
  // nothing to open and no state for whether it is open — the string is the
  // whole of it, and empty means no description.
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  // What is wrong with the suggestion being typed, against the field it is
  // wrong in rather than as a line of red under the whole card, which is
  // where the request that failed still reports itself.
  const [nameError, setNameError] = useState<string | null>(null)
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The row a delete is in flight for, closing while it waits; see
  // `removeOption`.
  const [removing, setRemoving] = useState<string | null>(null)
  const arriving = useArrivals(options)

  const kept = options.length - dropping.size + pending.length
  const full = kept >= MAX_OPTIONS
  const dirty = pending.length > 0 || dropping.size > 0 || edits.size > 0
  // A list that is already a ballot cannot be pruned below what an election
  // needs; a list still being collected can, because `finalize_options`
  // applies the floor when it becomes a ballot. The trigger enforces both,
  // and this only decides whether to offer the button. See
  // 0028_creator_edits_options.sql.
  // Counted against what *Done* would leave behind rather than against what is
  // on the poll now, since three options with two of them struck through is a
  // list already at the floor.
  const atFloor = drafting && kept <= 2

  /**
   * Every name the list would hold if it were saved as it stands, apart from
   * one row -- the row being checked, which is not its own duplicate.
   *
   * Struck rows are counted. They are still on the poll until *Done*, and a
   * list that let a name in because the row holding it was on its way out
   * would have to explain itself twice: once for accepting a name the list
   * visibly holds, and again when the way back -- *Keep* -- has been quietly
   * closed off behind it. Correcting the option that holds the name is the
   * answer to wanting the name, and is a press away; see `OptionEditor`.
   */
  function namesInUse(exceptKey?: string): string[] {
    // A row open for correcting counts as what is being typed into it rather
    // than as what it used to say: a name freed by a rename nobody has
    // pressed *Save* on yet is a name this list is about to want.
    const nameOf = (key: string, saved: string) =>
      editing?.key === key ? editing.name.trim() : saved

    return [
      ...options
        .filter((o) => o.id !== exceptKey)
        .map((o) => nameOf(o.id, (edits.get(o.id) ?? o).name)),
      ...pending.filter((o) => o.key !== exceptKey).map((o) => nameOf(o.key, o.name)),
    ]
  }

  /**
   * The correction in the open row, checked, or null with the reason marked
   * on the field it is about.
   *
   * The same shape `typedOption` has, and read in the same two places: by the
   * row's own *Save*, and by whatever ends the card.
   */
  function checkedEdit(): { key: string; name: string; description: string } | null {
    if (!editing) return null
    setEditProblem(null)

    const checked = checkOption(editing.name, editing.description, {
      adding: false,
      exceptKey: editing.key,
    })
    if ('field' in checked) {
      setEditProblem(checked)
      return null
    }

    return { key: editing.key, ...checked }
  }

  /**
   * A name and a description, checked the way the database would check them
   * -- trimmed and handed back, or the reason one of them is wrong and which
   * one it is.
   *
   * The same rules `insert_option` applies, checked here so the one that
   * fails is marked on the field it failed in. The database is still what
   * decides, these cannot be trusted and are not relied on, and anything it
   * refuses for a reason not listed here still comes back as the error under
   * the card.
   *
   * Shared by the box at the foot of the list and by a row being corrected in
   * place, which are the same four questions asked of the same two fields.
   * `adding` is the one difference: a correction puts nothing new on the
   * list, so the ceiling is not its to meet.
   */
  function checkOption(
    rawName: string,
    rawDescription: string,
    { adding, exceptKey }: { adding: boolean; exceptKey?: string },
  ): { name: string; description: string } | Problem {
    const trimmed = rawName.trim()
    const trimmedDescription = rawDescription.trim()

    if (!trimmed) return { field: 'name', message: 'Give the option a name.' }
    if (trimmed.length > OPTION_NAME_MAX)
      return { field: 'name', message: tooLong('An option name', trimmed.length, OPTION_NAME_MAX) }
    // Case-insensitive, like the database: two options differing only in
    // case are one option to everybody scoring the ballot. The draft is
    // checked alongside the list, because a name waiting to be saved is one
    // the save is about to refuse.
    if (namesInUse(exceptKey).some((existing) => existing.toLowerCase() === trimmed.toLowerCase()))
      return { field: 'name', message: `“${trimmed}” is already on the list.` }
    if (trimmedDescription.length > OPTION_DESCRIPTION_MAX)
      return {
        field: 'description',
        message: tooLong('A description', trimmedDescription.length, OPTION_DESCRIPTION_MAX),
      }
    if (adding && full)
      return {
        field: 'name',
        message: `This poll already holds the ${MAX_OPTIONS} options a ballot can.`,
      }

    return { name: trimmed, description: trimmedDescription }
  }

  /**
   * What is in the box, checked, or null with the reason marked on the field
   * it is about.
   *
   * Split from the add because the box is read twice: by *Add*, and by
   * whatever ends the card -- *Confirm options*, or the *Done* that leaves a
   * correction -- since an option typed and not added is part of the list
   * this reader means. See DraftHold.
   */
  function typedOption(): { name: string; description: string } | null {
    setNameError(null)
    setDescriptionError(null)
    setError(null)

    const checked = checkOption(name, description, { adding: true })
    if ('field' in checked) {
      if (checked.field === 'name') setNameError(checked.message)
      else setDescriptionError(checked.message)
      return null
    }

    return checked
  }

  /**
   * Put what is in the box on the list, and answer whether it got there.
   *
   * `quiet` is the same add made on the way past: the suggestion paths flush
   * the box before they confirm, and an option arriving is not news to the
   * person who just said they were done adding it. That act's own message and
   * its re-read cover both. See DraftHold.
   */
  async function addOption(quiet = false): Promise<boolean> {
    if (busy) return false

    const typed = typedOption()
    if (!typed) return false
    const { name: trimmed, description: trimmedDescription } = typed

    if (drafting) {
      draftSeq += 1
      setPending((prev) => [
        ...prev,
        { key: `draft-${draftSeq}`, name: trimmed, description: trimmedDescription },
      ])
      setName('')
      setDescription('')
      return true
    }

    setBusy(true)
    // Omitted rather than sent as null when there is nothing to say: the
    // argument defaults to NULL in the database, so the two reach
    // `insert_option` identically, and leaving it out is the shape the
    // generated `Args` describes.
    const body = { p_name: trimmed, p_description: trimmedDescription || undefined }
    const { error: rpcError } =
      source.kind === 'poll'
        ? await supabase.rpc('suggest_option', { p_poll_id: source.pollId, ...body })
        : await supabase.rpc('open_poll_suggest_option', { p_poll_id: source.pollId, ...body })
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return false
    }
    setName('')
    setDescription('')
    if (quiet) return true
    notifications.show({ message: `Added “${trimmed}”`, color: 'green' })
    onChanged()
    return true
  }

  /**
   * The whole draft -- what is going and what is coming -- in one press, and
   * in one request.
   *
   * It was two: a `delete` on the rows being dropped, and then the additions.
   * Which meant the poll passed through a list nobody had asked for, and the
   * floor under a live ballot was applied to it -- a poll of two options,
   * edited to drop one and add two, was refused for having fewer than two on
   * the way to three. `creator_edit_options` takes both halves and applies
   * the floor to where they land; see 0059_editing_options_in_one_go.sql.
   * A refusal now leaves the poll exactly as it was, so the draft is still
   * the whole of what is left to do and is kept intact.
   */
  async function saveDraft(
    extra: { name: string; description: string }[] = [],
    openEdit: { key: string; name: string; description: string } | null = null,
  ): Promise<boolean> {
    if (busy) return false
    if (!dirty && extra.length === 0 && !openEdit) return true
    setError(null)
    setBusy(true)

    // The correction still open in a row, folded in where it belongs: a row
    // of the poll joins the corrections, a row that is still a draft replaces
    // itself among them. Folded here rather than staged first, because
    // staging is state and this call reads the state it was rendered with.
    const drafts = pending.map((o) =>
      o.key === openEdit?.key
        ? { ...o, name: openEdit.name, description: openEdit.description }
        : o,
    )
    const staged = new Map(edits)
    if (openEdit && !pending.some((o) => o.key === openEdit.key))
      staged.set(openEdit.key, { name: openEdit.name, description: openEdit.description })

    // A correction goes in as the row leaving and the row arriving, which is
    // why it needs no door of its own: the removals are applied first and in
    // the same transaction, so an option corrected without being renamed is
    // never two options of that name. See `edits`.
    const { error: rpcError } = await supabase.rpc('creator_edit_options', {
      p_poll_id: source.pollId,
      p_options: [...drafts, ...staged.values(), ...extra].map((o) => ({
        name: o.name,
        description: o.description || null,
      })),
      p_remove: [...dropping, ...staged.keys()],
    })
    setBusy(false)

    if (rpcError) {
      setError(rpcError.message)
      return false
    }
    setPending([])
    setDropping(new Set())
    setEdits(new Map())
    setEditing(null)
    // Nothing said and nothing re-read: this is only ever a save made on the
    // way out of the card -- see DraftHold -- and the act it is part of says
    // so itself and re-reads the poll once, at the end.
    return true
  }

  /**
   * Everything this list is holding, in one request: the draft, the option
   * still sitting in the box, and the row still open for correcting.
   *
   * The box goes in with the rest rather than being added first, because
   * adding it first is a second request and a second thing to be refused
   * half-way through -- and because `addOption` only stages it here, so a
   * *Done* that staged and then saved would save the list as it was a moment
   * before, without it.
   */
  async function saveEverything(): Promise<boolean> {
    const typed = name.trim() ? typedOption() : null
    if (name.trim() && !typed) return false
    // A row left open is part of what this reader means as much as the box
    // is, so it goes in with everything else rather than being thrown away
    // for not having been saved by its own button.
    const openEdit = checkedEdit()
    if (editing && !openEdit) return false

    const saved = await saveDraft(typed ? [typed] : [], openEdit)
    if (!saved) return false
    setName('')
    setDescription('')
    return true
  }

  // What this list is holding that the poll does not, left where the card's
  // own button can apply it; see DraftHold. Written after every render rather
  // than once, because it closes over the draft and the box as they are now,
  // and taken back on the way out so no card confirms a list it has stopped
  // drawing.
  useEffect(() => {
    if (drafting) draft.current = dirty || name.trim() || editing ? () => saveEverything() : null
    // The suggestion paths hold nothing but the box and the open row: what is
    // on the list is already on the poll, having gone in as it was typed.
    else if (editing || name.trim())
      draft.current = async () => {
        if (editing && !(await saveEdit(true))) return false
        return name.trim() ? addOption(true) : true
      }
    else draft.current = null

    return () => {
      draft.current = null
    }
  })

  function dropDraft(key: string) {
    if (editing?.key === key) setEditing(null)
    setPending((prev) => {
      const left = prev.filter((o) => o.key !== key)
      return left
    })
  }

  /** Mark an option for removal, or take the marking back. */
  function toggleDropping(id: string) {
    setDropping((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    // A correction to a row that is leaving is a correction to nothing, and
    // keeping it would send an addition the removal beside it has already
    // accounted for. Striking a row out is saying you are done with it.
    if (editing?.key === id) setEditing(null)
    setEdits((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  /** Open a row's fields, filled in with what is in them now. */
  function openEditor(key: string, name: string, description: string) {
    setEditing({ key, name, description })
    setEditProblem(null)
  }

  /** A checked correction, into whichever draft the row it is about lives in. */
  function stage(edit: { key: string; name: string; description: string }) {
    const { key, ...fields } = edit
    if (pending.some((o) => o.key === key))
      setPending((prev) => prev.map((o) => (o.key === key ? { ...o, ...fields } : o)))
    else setEdits((prev) => new Map(prev).set(key, fields))
  }

  /**
   * The open row's correction, put in: staged on the creator's correction and
   * sent straight away on the two suggestion paths, which is the same split
   * adding and removing are under, and for the same reason -- that list
   * belongs to the group, and everybody watching sees it change as it
   * changes.
   *
   * `quiet` is the same save made on the way past, when the way out of the
   * card is applying what the row was still holding; that act re-reads the
   * poll itself. See DraftHold.
   */
  async function saveEdit(quiet = false): Promise<boolean> {
    if (busy) return false

    const edit = checkedEdit()
    if (!edit) return false

    if (drafting) {
      stage(edit)
      setEditing(null)
      return true
    }

    setError(null)
    setBusy(true)
    // One request, through the door the drafted correction goes through: the
    // row leaves and the corrected one arrives in the same transaction, so
    // the list is never briefly without it and the name it is keeping is
    // never briefly held twice. There is no update door into `candidates`.
    const { error: rpcError } = await supabase.rpc('creator_edit_options', {
      p_poll_id: source.pollId,
      p_options: [{ name: edit.name, description: edit.description || null }],
      p_remove: [edit.key],
    })
    setBusy(false)

    if (rpcError) {
      // Not a field's fault and not this row's to report: it goes under the
      // card with every other refusal, and the row stays open over it with
      // what was typed still in it.
      setError(rpcError.message)
      return false
    }
    setEditing(null)
    if (quiet) return true
    onChanged()
    return true
  }

  // The creator prunes the list directly, the same way they manage the invite
  // list: the row is theirs to delete under the poll's own policies, and
  // nothing about a poll with no votes in it needs a function to say so.
  //
  // Straight away only while the poll is still collecting, where the list
  // belongs to the group and everybody watching sees a row leave as it leaves.
  // The creator's own correction drafts it; see `toggleDropping`.
  async function removeOption(option: PollOption) {
    if (busy) return
    if (drafting) {
      toggleDropping(option.id)
      return
    }

    setError(null)
    setBusy(true)
    // Closed while the request is in the air rather than after it lands. The
    // row is the database's rather than this component's, so it does not
    // disappear until a re-read says it has — which is a round trip away, and
    // a list that sits perfectly still for a third of a second after a press
    // is a list that looks like it missed the press. Nothing is claimed by
    // this that is not about to be true: the row is gone from the poll before
    // it is gone from the screen, not after.
    setRemoving(option.id)
    const { error: deleteError } = await supabase.from('candidates').delete().eq('id', option.id)
    setBusy(false)

    if (deleteError) {
      // It is still there after all, so it comes back.
      setRemoving(null)
      setError(deleteError.message)
      return
    }
    onChanged()
  }

  return (
    <Stack gap="sm">
      {options.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing suggested yet. Add the first one.
        </Text>
      ) : (
        options.map((option) => {
          const struck = dropping.has(option.id)
          // The row as it would be saved: a correction waiting on *Done* is
          // shown where the option is rather than as a second row somewhere
          // else, because it is not a second option -- it is this one, as the
          // creator now means it.
          const shown = edits.get(option.id) ?? option

          return (
            /* The row's own box, which is what opens and closes; see
               listRow.module.css. Two things travel in it — the option and the
               rule under it — so the box has to space them itself, having taken
               them out of the `Stack` that was doing it. */
            <div
              key={option.id}
              className={`${listRow.row} ${arriving.has(option.id) ? listRow.joining : ''} ${
                removing === option.id ? listRow.leaving : ''
              }`}
            >
              <div className={`${listRow.content} ${listRow.stacked}`}>
                {editing?.key === option.id ? (
                  <OptionEditor
                    value={editing}
                    problem={editProblem}
                    busy={busy}
                    onChange={setEditing}
                    onCancel={() => setEditing(null)}
                    onSave={() => saveEdit()}
                  />
                ) : (
                  <Group justify="space-between" wrap="nowrap" gap="sm">
                    <div style={{ minWidth: 0 }}>
                      {/* Struck through rather than gone, while the removal is
                          still a draft: the row is what the press acted on, and
                          showing it crossed out is what makes the press
                          takeable-back without a second list of what is missing.
                          Name and description together, because what is leaving
                          is the option rather than what it is called. */}
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
                    {isCreator &&
                      (struck ? (
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          onClick={() => toggleDropping(option.id)}
                        >
                          Keep
                        </Button>
                      ) : (
                        <Group gap={4} wrap="nowrap">
                          {/* Beside the remove rather than instead of it: an
                              option that is wrong in a word is corrected, and
                              one that is wrong altogether goes. Fixing a typo
                              in a description used to mean typing the whole
                              description again under a new option. */}
                          <ActionIcon
                            variant="subtle"
                            aria-label={`Edit ${shown.name}`}
                            onClick={() =>
                              openEditor(option.id, shown.name, shown.description ?? '')
                            }
                          >
                            <PencilSimpleIcon size={16} aria-hidden />
                          </ActionIcon>
                          <Tooltip
                            label="A poll needs at least two options"
                            disabled={!atFloor}
                            withArrow
                          >
                            {/* The span is what a tooltip on a disabled button
                            needs: a disabled control fires no pointer events of
                            its own, so the reason it is disabled would never be
                            readable without something around it that does. */}
                            <span>
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                disabled={atFloor}
                                aria-label={`Remove ${shown.name}`}
                                onClick={() => removeOption(option)}
                              >
                                &times;
                              </ActionIcon>
                            </span>
                          </Tooltip>
                        </Group>
                      ))}
                  </Group>
                )}
                <Divider />
              </div>
            </div>
          )
        })
      )}

      {/* The draft, under the list it is about to join, and drawn exactly as
          the rest of it. It used to be dimmed, to mark what the poll did not
          hold yet -- which was a distinction for a Save button that no longer
          exists: the way out of this card is the save, so an option waiting
          here is an option on the list. */}
      {pending.map((option) => (
        <div key={option.key} className={`${listRow.row} ${listRow.joining}`}>
          <div className={`${listRow.content} ${listRow.stacked}`}>
            {editing?.key === option.key ? (
              <OptionEditor
                value={editing}
                problem={editProblem}
                busy={busy}
                onChange={setEditing}
                onCancel={() => setEditing(null)}
                onSave={() => saveEdit()}
              />
            ) : (
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <div style={{ minWidth: 0 }}>
                  <Text fw={500}>{option.name}</Text>
                  {option.description && <OptionDescription description={option.description} />}
                </div>
                {/* Corrected the same way as a row already on the poll, and it
                    is the same press: a draft is an option this reader means,
                    and the only difference is that nothing has to be sent
                    anywhere to change it. */}
                <Group gap={4} wrap="nowrap">
                  <ActionIcon
                    variant="subtle"
                    aria-label={`Edit ${option.name}`}
                    onClick={() => openEditor(option.key, option.name, option.description)}
                  >
                    <PencilSimpleIcon size={16} aria-hidden />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Discard ${option.name}`}
                    onClick={() => dropDraft(option.key)}
                  >
                    &times;
                  </ActionIcon>
                </Group>
              </Group>
            )}
            <Divider />
          </div>
        </div>
      ))}

      <Group gap="xs" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{ flex: 1 }}>
          <TextInput
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value)
              // The message was about what was in the box; it stops being
              // true the moment that changes.
              setNameError(null)
            }}
            placeholder="Add an option"
            error={nameError}
            /* The field stands alone rather than in a form, so Enter has
               nothing to submit unless it is given something. */
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              addOption()
            }}
          />
          {/* No autoFocus: the field is here on arrival rather than
              opened, so taking the cursor off the name field would be
              taking it off the one thing every option needs. */}
          <DescriptionField
            value={description}
            onChange={(e) => {
              setDescription(e.currentTarget.value)
              setDescriptionError(null)
            }}
            placeholder="Description (optional)"
            error={descriptionError}
          />
        </Stack>
        <Button variant="light" onClick={() => addOption()} disabled={full}>
          Add
        </Button>
      </Group>

      {full && (
        <Text size="xs" c="dimmed">
          A ballot may only have {MAX_OPTIONS} options.
        </Text>
      )}

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
    </Stack>
  )
}

/**
 * One option's two fields, opened in the row the option is in.
 *
 * In place rather than in a modal, because a correction is usually a word: a
 * dialog over the list would hide the thing being corrected and the list it
 * has to be read against. The row keeps its divider, so the list does not
 * come apart as one of its rows opens.
 *
 * Controlled, and holding nothing of its own: what is typed here belongs to
 * the list, which is what lets the way out of the card put in a correction
 * that was never saved by its own button. See DraftHold, and `editing`.
 */
function OptionEditor({
  value,
  problem,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  value: { key: string; name: string; description: string }
  /** What is wrong with it, or null. Marked on the field it is about. */
  problem: Problem | null
  /** Whether the correction is in the air; the row's buttons wait for it. */
  busy: boolean
  onChange: (value: { key: string; name: string; description: string }) => void
  onCancel: () => void
  onSave: () => void
}) {
  return (
    /* Escape on the row rather than on the name field, so it is the way out
       from either box. */
    <Stack
      gap={4}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onCancel()
      }}
    >
      <TextInput
        value={value.name}
        /* Focused on opening, unlike the box at the foot of the list: that
           field is here on arrival, while this one was opened by a press that
           was about this option, and the cursor being in it is the whole of
           what that press asked for. */
        autoFocus
        onChange={(e) => onChange({ ...value, name: e.currentTarget.value })}
        error={problem?.field === 'name' ? problem.message : null}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          onSave()
        }}
      />
      <DescriptionField
        value={value.description}
        onChange={(e) => onChange({ ...value, description: e.currentTarget.value })}
        placeholder="Description (optional)"
        error={problem?.field === 'description' ? problem.message : null}
      />
      <Group gap="xs" justify="flex-end">
        <Button variant="subtle" size="compact-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="light" size="compact-sm" loading={busy} onClick={onSave}>
          Save
        </Button>
      </Group>
    </Stack>
  )
}

/**
 * The same list, on a poll that finds a time: a calendar rather than a text
 * box, and one request rather than one per window.
 *
 * Everything about *who may do what* is the same as the list above -- the
 * three sources are the same three, and only the creator may take something
 * off -- so what differs is the gesture and the endpoint it lands on. See
 * `PaintTimes` for the gesture and 0056_schedule_options.sql for why the
 * plural endpoint had to exist before a time poll could collect anything.
 */
function TimeList({
  source,
  options,
  schedule,
  isCreator,
  ownSave,
  draft,
  onChanged,
}: {
  source: OptionsSource
  options: PollOption[]
  schedule: PollSchedule
  isCreator: boolean
  /** Whether the calendar carries its own *Save times*; see CollectOptions. */
  ownSave: boolean
  /** Where the painting goes instead, when it does not. */
  draft: DraftHold
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The painting's difference from the list, as the calendar last reported
  // it. Held rather than read back out of it: a window is a run of cells, so
  // working out which windows a painting means is the calendar's job and is
  // done in one place.
  const [painted, setPainted] = useState<PaintedEdit | null>(null)

  const noteDraft = useCallback((edit: PaintedEdit | null) => {
    setPainted(edit)
  }, [])

  async function save(add: string[], removeIds: string[], quiet = false): Promise<boolean> {
    if (busy) return false
    setError(null)
    setBusy(true)

    // The creator's correction to a list that is already a ballot goes in as
    // one edit, because the two-option floor is applied to a live ballot a
    // row at a time: an afternoon swapped for another afternoon passes
    // through a list of one window, which is not a list anybody was offered.
    // See 0059_editing_options_in_one_go.sql.
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

    // Removals first, so a save that swaps one window for another cannot trip
    // over the 500-option ceiling on its way through the middle. A list still
    // being collected has no floor to fall through in between; that is
    // finalize_options's, when the list becomes a ballot.
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

  /**
   * What every path does once the windows are in.
   *
   * `quiet` is a save made on the way past: the way out of the card --
   * *Confirm options*, or *Done* -- puts the painting in before it goes, and
   * that act says so itself and re-reads the poll once, at the end. See
   * DraftHold.
   */
  function landed(add: string[], removeIds: string[], quiet: boolean) {
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

  // The painting, left where the card's own button can apply it; see
  // DraftHold. After every render rather than once, so that what it puts in
  // is the painting as it now stands.
  useEffect(() => {
    draft.current = painted ? () => save(painted.add, painted.removeIds, true) : null

    return () => {
      draft.current = null
    }
  })

  return (
    <Stack gap="sm">
      <PaintTimes
        schedule={schedule}
        options={options}
        // Taking somebody else's suggestion off the list is the creator's job
        // everywhere else in this app, and is that here too.
        canRemove={isCreator}
        saving={busy}
        showSave={ownSave}
        onSave={save}
        onDraftChange={noteDraft}
      />
      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
    </Stack>
  )
}

/**
 * A painting's worth of windows, through whichever of the three doors this
 * reader came in by.
 *
 * One request whichever it is, which is the point: a gesture on that calendar
 * is a handful of windows, and inserting them one at a time could leave a day
 * with morning windows and no afternoon if the run stopped part-way.
 */
function sendTimes(source: OptionsSource, names: string[]) {
  const body = { p_options: names.map((name) => ({ name })) }
  if (source.kind === 'poll')
    return supabase.rpc('suggest_options', { p_poll_id: source.pollId, ...body })
  if (source.kind === 'creator') {
    return supabase.rpc('creator_add_options', { p_poll_id: source.pollId, ...body })
  }
  return supabase.rpc('open_poll_suggest_options', { p_poll_id: source.pollId, ...body })
}

/**
 * Who is done adding options, on an open poll that names its respondents.
 *
 * The invite side has no card of its own: its roster *is* the invite list, so
 * `Respondents` says it there, on the card it already draws, with the badge
 * answering "confirmed?" instead of "voted?" while the poll is still
 * collecting. Behind a share link there is no list to annotate — the names
 * exist only because people typed them — so there is a card.
 *
 * No embargo, unlike the voter roster it sits in place of. What that embargo
 * protects is the order ballots arrived in; a poll still collecting its
 * options has no ballots to attach an order to, and knowing who has finished
 * is the entire point of the thing.
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
 * Which options were not in the list a moment ago.
 *
 * This list belongs to the poll rather than to whoever is looking at it: a
 * suggestion typed on somebody else's phone arrives here on the live tick,
 * with nothing to say it just did. Marking what is new is how a list that
 * grew under the reader says so, and it is the same mark whether the reader
 * added the row themselves or watched it turn up.
 *
 * **Nothing is new on the first read.** A card opening with six options has
 * not just been given six options, and animating them in one by one would
 * make the arrival of the card look like the arrival of its contents. So the
 * first list is taken as the starting position and only what follows counts.
 *
 * Answered a render late, because it is answered from an effect: the row is
 * drawn plain and the mark lands on the frame after, which is what makes the
 * animation run at all — a class an element is born with has nothing to
 * animate from.
 */
function useArrivals(options: PollOption[]): ReadonlySet<string> {
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set())
  // Null until the first list has been seen, which is what tells "nothing has
  // arrived yet" apart from "the list is empty".
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
