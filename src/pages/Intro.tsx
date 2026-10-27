import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, Group, Stack, Text, UnstyledButton, VisuallyHidden } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { BookOpenIcon, CheckIcon, PlusIcon, ShareNetworkIcon } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { Features } from '../components/intro/Features'
import { Film } from '../components/intro/Film'
import {
  CLOSE,
  COL,
  FILMS,
  FOOTAGE,
  p01,
  tween,
  TOTAL,
  type FilmShape,
} from '../components/intro/motion'
import { useMakePoll } from '../lib/makePoll'
import { shareLink } from '../lib/share'
import { announce } from '../lib/announce'

/**
 * The intro: a film of the app at work — a poll made, its options gathered,
 * rated, voted in and decided — ending on the things a newcomer might do
 * next and a carousel of what the film had no time for.
 *
 * It is a page of its own, outside the app shell, because it is a film of the
 * app rather than a page in it — the footage has the app's header in it, and
 * a real one above it would be the same header twice. It is reachable signed
 * in or out, since the reader it is for has usually never signed in. See "The
 * intro" in AGENTS.md.
 */
export function Intro() {
  const reducedMotion = useReducedMotion(false, { getInitialValueInEffect: false })
  const video = useRef<HTMLVideoElement>(null)
  const follow = useCallback((t: number) => followVideo(video.current, t), [])
  const T = useFilmClock(reducedMotion, follow)
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
    // The page's main landmark, since it sits outside the app shell that
    // provides one everywhere else.
    <main
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        background: COL.bg,
      }}
    >
      <VisuallyHidden>
        <h1>ChoiceLab</h1>
        <p>
          A short video of the app: somebody makes a poll asking which movie to watch and which
          night, friends suggest films, everyone rates the films from zero to five stars and marks
          the nights that suit them, and closing the poll shows the winner of each.
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
        <Film T={T.value} shape={shape} video={video} />
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
    </main>
  )
}

/**
 * The three ways on from the film, rising in one after another once the logo
 * and the wordmark have settled, with the features under them. Hidden rather
 * than merely transparent until then, so nobody tabs onto a button they
 * cannot see.
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

  // Make your own poll goes straight to the create form for everybody; see
  // lib/makePoll.ts.
  const { start: makePoll, starting, error } = useMakePoll()

  async function share() {
    // The phone's own share sheet where there is one, since that is where the
    // people this is going to are; a copied link everywhere else. See
    // lib/share.ts for why the link rides inside the text.
    const outcome = await shareLink({
      title: 'ChoiceLab',
      text: 'Check out ChoiceLab!',
      url: `${window.location.origin}${window.location.pathname}#/intro`,
    })
    if (outcome === 'copied') {
      setCopied(true)
      announce('Link copied')
    }
  }

  const start = CLOSE + 1.65
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
  // two quieter buttons look the same in either colour scheme. Their text is
  // `blue.8` rather than the primary shade: it is text on white, not a filled
  // control, so it is held to 4.5:1 like any other.
  const quiet = {
    variant: 'white' as const,
    size,
    c: 'blue.8',
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
      Learn more
    </Button>,
    !makePoll ? (
      <Button
        key="make"
        size={size}
        color="blue"
        component={Link}
        to="/new"
        leftSection={<PlusIcon size={18} aria-hidden />}
        style={rise(1)}
      >
        Make your own poll
      </Button>
    ) : (
      <Button
        key="make"
        size={size}
        color="blue"
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
    <Text role="alert" size="sm" c="red" ta="center">
      {error}
    </Text>
  )

  const features = (
    <Features shown={T >= start + 0.45} style={{ ...rise(3), marginTop: portrait ? 8 : 20 }} />
  )

  return portrait ? (
    <Stack gap="sm" align="stretch" maw={320} mx="auto" style={style}>
      {buttons}
      {failed}
      {features}
    </Stack>
  ) : (
    <Stack gap="xs" style={style}>
      <Group gap="md" justify="center">
        {buttons}
      </Group>
      {failed}
      {features}
    </Stack>
  )
}

/**
 * Keeps the footage and the film's clock together. While the footage is on,
 * the video is the clock: the film follows its playhead, so a video that
 * stops to buffer holds the film rather than the film running on without it.
 * A clock that has moved somewhere the video is not — a skip, a replay, the
 * other shape's video taking over on a rotation — seeks the video to it.
 * Outside the footage it rests on its first or last frame and the film keeps
 * its own time. A video that will not play (autoplay refused) leaves the film
 * to run on its own past a still picture.
 */
function followVideo(v: HTMLVideoElement | null, t: number): number | null {
  if (!v) return null
  const end = CLOSE - FOOTAGE
  const at = t - FOOTAGE
  if (at < 0 || at >= end) {
    if (!v.paused) v.pause()
    const rest = at < 0 ? 0 : Math.max(0, end - 0.05)
    if (Math.abs(v.currentTime - rest) > 0.1) v.currentTime = rest
    return null
  }
  if (v.dataset.refused) return null
  if (Math.abs(v.currentTime - at) > 0.5) {
    v.currentTime = at
    return t
  }
  if (v.ended) return null
  if (v.paused)
    void v.play().catch(() => {
      v.dataset.refused = 'true'
    })
  // Buffering: hold the film where the video is.
  return FOOTAGE + v.currentTime
}

/**
 * The film's clock: seconds since it started, stopping at the end and holding
 * the last frame. A reader who has asked for less motion starts on that frame.
 * `follow` may take the time from somewhere else for a while (the footage;
 * see `followVideo`), and returns null to let the clock run on its own.
 *
 * A hidden tab gets no animation frames, and the step is capped so that
 * coming back to one carries on from where it was rather than leaping ahead.
 */
function useFilmClock(reducedMotion: boolean, follow: (t: number) => number | null) {
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
      setValue((t) => Math.min(TOTAL, follow(t) ?? t + dt))
      id = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(id)
  }, [playing, follow])

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
