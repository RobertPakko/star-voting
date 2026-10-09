import { useEffect, useState, type CSSProperties } from 'react'
import { Button, Group, Stack, Text, UnstyledButton, VisuallyHidden } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { BookOpenIcon, CheckIcon, PlusIcon, ShareNetworkIcon } from '@phosphor-icons/react'
import { Link, useNavigate } from 'react-router-dom'
import { LandscapeFilm } from '../components/intro/Landscape'
import { PortraitFilm } from '../components/intro/Portrait'
import { COL, CUES, FILMS, p01, tween, TOTAL, type FilmShape } from '../components/intro/motion'
import { useAuth } from '../lib/auth'

/**
 * The intro: a twenty-two-second film of a poll being made, voted in and
 * decided, ending on the three things a newcomer might do next.
 *
 * It is a page of its own, outside the app shell, because it is a film of the
 * app rather than a page in it — the film draws the app's header itself, and
 * a real one above it would be the same header twice. It is reachable signed
 * in or out, since the reader it is for has usually never signed in. See "The
 * intro" in AGENTS.md.
 */
export function Intro() {
  const reducedMotion = useReducedMotion(false, { getInitialValueInEffect: false })
  const T = useFilmClock(reducedMotion)
  const { width, height } = useWindowSize()

  // Whichever shape draws the film larger in this window, which comes to the
  // portrait one exactly when the window is taller than it is wide.
  const shape: FilmShape = width < height ? 'portrait' : 'landscape'
  const film = FILMS[shape]
  const scale = Math.min(width / film.w, height / film.h)
  const left = (width - film.w * scale) / 2
  const top = (height - film.h * scale) / 2
  const ended = T.value >= TOTAL

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        background: COL.bg,
      }}
    >
      <VisuallyHidden>
        <h1>STAR Voting</h1>
        <p>
          A short animation: somebody creates a poll, everyone rates the options from zero to five
          stars, and the two highest-scoring options meet in an automatic runoff to decide the
          winner.
        </p>
      </VisuallyHidden>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left,
          top,
          width: film.w,
          height: film.h,
          transformOrigin: '0 0',
          transform: `scale(${scale})`,
          pointerEvents: 'none',
        }}
      >
        {shape === 'portrait' ? <PortraitFilm T={T.value} /> : <LandscapeFilm T={T.value} />}
      </div>

      <Actions
        T={T.value}
        portrait={shape === 'portrait'}
        style={{ position: 'absolute', left: 16, right: 16, top: top + film.actions * scale }}
      />

      {/* Skipping goes to the last frame; a reader who asked for less motion
          starts there, and has nothing to watch again. */}
      {!(ended && reducedMotion) && (
        <UnstyledButton
          onClick={ended ? T.replay : T.skip}
          style={{
            position: 'absolute',
            right: 16,
            bottom: 16,
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 14,
            color: COL.gray7,
          }}
        >
          {ended ? 'Watch again' : 'Skip'}
        </UnstyledButton>
      )}
    </div>
  )
}

/**
 * The three ways on from the film, rising in one after another once the logo
 * and the wordmark have settled. Hidden rather than merely transparent until
 * then, so nobody tabs onto a button they cannot see.
 *
 * They are drawn at the page's own size rather than the film's, which is why
 * they sit over it instead of inside it: a button scaled down with a film
 * drawn at 1920 pixels wide would be a button too small to press on a phone.
 */
function Actions({ T, portrait, style }: { T: number; portrait: boolean; style: CSSProperties }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(id)
  }, [copied])

  // Make your own poll goes straight to the create form for everybody, as the
  // About page's "Try it yourself" does: a reader with no session is given one
  // without an account on the press rather than sent to the sign-in screen.
  // The navigation waits for the session to arrive, because `/polls/new`
  // without one is matched as a poll whose id is "new".
  const { session, continueWithoutAccount } = useAuth()
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (starting && session) navigate('/polls/new')
  }, [starting, session, navigate])

  async function makePoll() {
    setError(null)
    setStarting(true)
    try {
      await continueWithoutAccount()
    } catch (e) {
      setStarting(false)
      setError(e instanceof Error ? e.message : 'Could not start a poll. Try again.')
    }
  }

  async function share() {
    const url = `${window.location.origin}${window.location.pathname}#/intro`
    const data = {
      title: 'STAR Voting',
      text: 'A short look at how STAR Voting helps a group decide.',
      url,
    }
    // The phone's own share sheet where there is one, since that is where the
    // people this is going to are; a copied link everywhere else.
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data)
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Nothing left to try; the address bar still has the link in it.
    }
  }

  const start = CUES.Close + 1.15
  const rise = (i: number): CSSProperties => {
    const a = start + i * 0.15
    const o = p01(T, a, a + 0.45)
    return {
      opacity: o,
      visibility: o > 0 ? 'visible' : 'hidden',
      transform: `translateY(${tween(T, a, a + 0.45, 16, 0)}px)`,
    }
  }
  const size = portrait ? 'md' : 'lg'
  // White on the film's grey, with a border of the film's own colour, so the
  // two quieter buttons look the same in either colour scheme.
  const quiet = {
    variant: 'white' as const,
    size,
    bd: `1px solid ${COL.border}`,
  }

  const buttons = [
    <Button
      key="learn"
      {...quiet}
      component={Link}
      to="/about"
      leftSection={<BookOpenIcon size={18} aria-hidden />}
      style={rise(0)}
    >
      Learn more about STAR
    </Button>,
    session ? (
      <Button
        key="make"
        size={size}
        color={COL.blue}
        component={Link}
        to="/polls/new"
        leftSection={<PlusIcon size={18} aria-hidden />}
        style={rise(1)}
      >
        Make your own poll
      </Button>
    ) : (
      <Button
        key="make"
        size={size}
        color={COL.blue}
        onClick={() => void makePoll()}
        loading={starting}
        leftSection={<PlusIcon size={18} aria-hidden />}
        style={rise(1)}
      >
        Make your own poll
      </Button>
    ),
    <Button
      key="share"
      {...quiet}
      onClick={() => void share()}
      leftSection={
        copied ? <CheckIcon size={18} aria-hidden /> : <ShareNetworkIcon size={18} aria-hidden />
      }
      style={rise(2)}
    >
      {copied ? 'Link copied' : 'Share this intro'}
    </Button>,
  ]
  const failed = error && (
    <Text size="sm" c="red" ta="center">
      {error}
    </Text>
  )

  return portrait ? (
    <Stack gap="sm" align="stretch" maw={320} mx="auto" style={style}>
      {buttons}
      {failed}
    </Stack>
  ) : (
    <Stack gap="xs" style={style}>
      <Group gap="md" justify="center">
        {buttons}
      </Group>
      {failed}
    </Stack>
  )
}

/**
 * The film's clock: seconds since it started, stopping at the end and holding
 * the last frame. A reader who has asked for less motion starts on that frame.
 *
 * A hidden tab gets no animation frames, and the step is capped so that
 * coming back to one carries on from where it was rather than leaping ahead.
 */
function useFilmClock(reducedMotion: boolean) {
  const [value, setValue] = useState(() => (reducedMotion ? TOTAL : 0))
  const playing = value < TOTAL

  useEffect(() => {
    if (reducedMotion) setValue(TOTAL)
  }, [reducedMotion])

  useEffect(() => {
    if (!playing) return
    let last: number | null = null
    let id = requestAnimationFrame(function step(now) {
      const dt = last === null ? 0 : Math.min((now - last) / 1000, 0.1)
      last = now
      setValue((t) => Math.min(TOTAL, t + dt))
      id = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(id)
  }, [playing])

  return {
    value,
    skip: () => setValue(TOTAL),
    replay: () => setValue(reducedMotion ? TOTAL : 0),
  }
}

function useWindowSize() {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const onResize = () => setSize(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}
