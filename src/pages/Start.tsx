import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Loader, VisuallyHidden } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import {
  ArrowsClockwiseIcon,
  BellIcon,
  ChartBarIcon,
  CodeIcon,
  DeviceMobileIcon,
  DevicesIcon,
  GiftIcon,
  PlusIcon,
  ProhibitIcon,
  ScalesIcon,
  StarIcon,
  UserCircleDashedIcon,
  type Icon,
} from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { useMakePoll } from '../lib/makePoll'
import { pollPath } from '../lib/pollId'
import { SAMPLE_POLL_ID, SAMPLE_RESULT_ID } from '../lib/samplePoll'
import { APP_TITLE, usePageTitle } from '../lib/pageTitle'
import classes from './Start.module.css'

/**
 * `#/start`: the app on one screen, for somebody who has just heard of it and
 * will give it a few seconds. The logo, and six circles turning slowly round
 * it — three to press and three to look at, alternating.
 *
 * Nothing in the app links here. It is an address to hand out — on a poster,
 * in a bio — and outside the app shell like the intro, which it is the short
 * version of. See "The Start page" in AGENTS.md.
 */
export function Start() {
  usePageTitle(APP_TITLE)
  const reducedMotion = useReducedMotion(false, { getInitialValueInEffect: false })
  const make = useMakePoll()

  return (
    <main className={classes.page}>
      <VisuallyHidden>
        <h1>ChoiceLab</h1>
        <p>Group decisions, made simple.</p>
      </VisuallyHidden>
      <div className={classes.ring}>
        <div className={classes.orbit}>
          {/* Clockwise from the top. Each side pairs a loop with the sample
              closest to it: choosing a place beside its result, choosing a time
              beside the poll that asks one. */}
          <Spot at={0} small>
            {make.start ? (
              <button
                type="button"
                className={classes.link}
                data-tone="create"
                onClick={() => void make.start?.()}
                disabled={make.starting}
              >
                <LinkFace
                  icon={
                    make.starting ? <Loader size="sm" color="white" /> : <PlusIcon aria-hidden />
                  }
                  label="Make your own poll"
                />
              </button>
            ) : (
              <Link to="/new" className={classes.link} data-tone="create">
                <LinkFace icon={<PlusIcon aria-hidden />} label="Make your own poll" />
              </Link>
            )}
          </Spot>
          <Spot at={60}>
            <Loop name="place" label="Choose a place" still={reducedMotion} />
          </Spot>
          <Spot at={120} small>
            <Link to={pollPath(SAMPLE_RESULT_ID)} className={classes.link} data-tone="result">
              <LinkFace icon={<ChartBarIcon aria-hidden />} label="See a sample result" />
            </Link>
          </Spot>
          <Spot at={180}>
            <Benefits still={reducedMotion} />
          </Spot>
          <Spot at={240} small>
            <Link to={pollPath(SAMPLE_POLL_ID)} className={classes.link} data-tone="poll">
              <LinkFace icon={<StarIcon weight="fill" aria-hidden />} label="See a sample poll" />
            </Link>
          </Spot>
          <Spot at={300}>
            <Loop name="time" label="Choose a time" still={reducedMotion} />
          </Spot>
        </div>
        <Link to="/about" className={classes.logo} aria-label="About ChoiceLab">
          <StarIcon weight="fill" aria-hidden />
          <span className={classes.wordmark} aria-hidden>
            ChoiceLab
          </span>
        </Link>
      </div>
      {make.error && (
        <p role="alert" className={classes.error}>
          {make.error}
        </p>
      )}
    </main>
  )
}

/**
 * Where a circle sits: `at` degrees clockwise from the top. The ring turns and
 * the circle turns back the other way just as fast, so its face stays upright.
 */
function Spot({ at, small, children }: { at: number; small?: boolean; children: ReactNode }) {
  const a = (at * Math.PI) / 180
  return (
    <div
      className={classes.spot}
      data-small={small || undefined}
      style={{ '--x': Math.sin(a).toFixed(4), '--y': (-Math.cos(a)).toFixed(4) } as CSSProperties}
    >
      <div className={classes.upright}>{children}</div>
    </div>
  )
}

function LinkFace({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <>
      <span className={classes.icon}>{icon}</span>
      <span>{label}</span>
    </>
  )
}

/**
 * A few seconds of the app in use, recorded from the sample poll by
 * `npm run videos`. Decoration — what it shows, the links beside it say — so
 * it is hidden from a screen reader. Under reduced motion it is its poster,
 * the loop's last frame.
 */
function Loop({ name, label, still }: { name: string; label: string; still: boolean }) {
  const src = `${import.meta.env.BASE_URL}start/${name}`
  return (
    <div className={classes.feature}>
      <video
        className={classes.video}
        src={`${src}.mp4`}
        poster={`${src}.jpg`}
        autoPlay={!still}
        loop
        muted
        playsInline
        preload={still ? 'none' : 'auto'}
        aria-hidden
        tabIndex={-1}
        disablePictureInPicture
      />
      <span className={classes.caption}>{label}</span>
    </div>
  )
}

/**
 * As short as they can be: on a phone the circle is about 130 pixels across,
 * which is room for an icon and two short words.
 */
const BENEFITS: { icon: Icon; text: string }[] = [
  { icon: GiftIcon, text: 'Free' },
  { icon: ProhibitIcon, text: 'No ads' },
  { icon: UserCircleDashedIcon, text: 'No sign-up' },
  { icon: ScalesIcon, text: 'Fair results' },
  { icon: ArrowsClockwiseIcon, text: 'Live updates' },
  { icon: DevicesIcon, text: 'Any device' },
  { icon: DeviceMobileIcon, text: 'Installable' },
  { icon: BellIcon, text: 'Notifications' },
  { icon: CodeIcon, text: 'Open source' },
]

/** How long each benefit holds the middle of the circle. */
const BENEFIT_MS = 2200

/**
 * The benefits, rolling upwards one at a time through the middle of the
 * circle, with the one before and the one after faded either side of it.
 *
 * Each item is placed by how far it is from the one in the middle, wrapped
 * round the list, so the roll never ends and needs no second copy of the
 * list. An item wrapping from the top to the bottom crosses the circle on its
 * way, invisibly: it is transparent at both ends of the move. A screen reader
 * is given the list whole instead, rather than a carousel.
 */
function Benefits({ still }: { still: boolean }) {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setIndex((i) => i + 1), BENEFIT_MS)
    return () => clearInterval(id)
  }, [])

  const n = BENEFITS.length
  return (
    <div className={classes.feature} data-tone="benefits">
      <VisuallyHidden>
        <ul>
          {BENEFITS.map(({ text }) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </VisuallyHidden>
      <ul className={classes.benefits} aria-hidden>
        {BENEFITS.map(({ icon: Glyph, text }, i) => {
          // -n/2 … n/2, so the items behind the middle one are above it.
          const offset = ((((i - index) % n) + n + Math.floor(n / 2)) % n) - Math.floor(n / 2)
          return (
            <li
              key={text}
              className={classes.benefit}
              data-still={still || undefined}
              style={
                {
                  '--offset': offset,
                  opacity: offset === 0 ? 1 : Math.abs(offset) === 1 ? 0.35 : 0,
                } as CSSProperties
              }
            >
              <Glyph aria-hidden weight="bold" />
              <span>{text}</span>
            </li>
          )
        })}
      </ul>
      <span className={classes.caption}>Make it easy</span>
    </div>
  )
}
