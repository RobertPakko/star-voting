import { useEffect, useState, type CSSProperties } from 'react'
import { ActionIcon, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { CaretLeftIcon, CaretRightIcon, PauseIcon, PlayIcon } from '@phosphor-icons/react'
import { SITE_FEATURES as FEATURES } from '../siteFeatures'
import { COL } from './motion'

/**
 * The film is light in both schemes, so a link in a feature takes the light
 * scheme's anchor colour rather than the dark one, which is unreadable on the
 * white card.
 */
const LIGHT_ANCHOR = { '--mantine-color-anchor': '#1971c2' } as CSSProperties

/** How long each feature is shown before the next. */
const DWELL_MS = 4000

/**
 * The features, turning on their own until the reader pauses them, presses
 * either arrow, or puts the pointer or focus on them. A reader who has asked
 * for less motion gets the arrows and no turning. Paused, the card is a live
 * region, so a feature brought up by an arrow is read out.
 */
export function Features({ shown, style }: { shown: boolean; style?: CSSProperties }) {
  const reducedMotion = useReducedMotion()
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [held, setHeld] = useState(false)
  // Still until it has risen into view, so it starts on the first feature.
  const turning = shown && !reducedMotion && !paused && !held

  useEffect(() => {
    if (!turning) return
    const id = setInterval(() => setIndex((i) => (i + 1) % FEATURES.length), DWELL_MS)
    return () => clearInterval(id)
  }, [turning])

  const step = (by: number) => {
    setPaused(true)
    setIndex((i) => (i + by + FEATURES.length) % FEATURES.length)
  }

  return (
    <section
      aria-roledescription="carousel"
      aria-label="What else ChoiceLab does"
      style={{ width: '100%', maxWidth: 440, marginInline: 'auto', ...style }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false)
      }}
    >
      <Group gap="xs" wrap="nowrap" align="center">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label="Previous feature"
          onClick={() => step(-1)}
        >
          <CaretLeftIcon size={18} aria-hidden />
        </ActionIcon>
        <Paper
          withBorder
          radius="md"
          p="sm"
          bg="#fff"
          style={{
            flex: 1,
            minHeight: 72,
            borderColor: COL.border,
            overflow: 'hidden',
            ...LIGHT_ANCHOR,
          }}
          aria-live={turning ? 'off' : 'polite'}
        >
          <div style={{ display: 'grid' }}>
            {FEATURES.map((f, i) => (
              <Group
                key={f.title}
                gap="sm"
                wrap="nowrap"
                align="center"
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${FEATURES.length}`}
                aria-hidden={i !== index}
                style={{
                  gridArea: '1 / 1',
                  opacity: i === index ? 1 : 0,
                  visibility: i === index ? 'visible' : 'hidden',
                  transform: `translateX(${i === index ? 0 : i < index ? -12 : 12}px)`,
                  // The one leaving is gone before the one arriving shows, so
                  // the two never read over each other.
                  transition:
                    i === index
                      ? 'opacity var(--motion-base) ease var(--motion-fast), transform var(--motion-base) ease var(--motion-fast), visibility 0s'
                      : 'opacity var(--motion-fast) ease, transform var(--motion-fast) ease, visibility 0s var(--motion-fast)',
                }}
              >
                <ThemeIcon variant="light" size={44} radius="xl">
                  <f.icon size={24} aria-hidden />
                </ThemeIcon>
                <Stack gap={0}>
                  <Text fw={700} c={COL.text}>
                    {f.title}
                  </Text>
                  <Text size="sm" c={COL.gray7}>
                    {f.text}
                  </Text>
                </Stack>
              </Group>
            ))}
          </div>
        </Paper>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label="Next feature"
          onClick={() => step(1)}
        >
          <CaretRightIcon size={18} aria-hidden />
        </ActionIcon>
      </Group>
      <Group justify="center" gap={6} mt={8}>
        <div aria-hidden style={{ display: 'flex', gap: 6 }}>
          {FEATURES.map((f, i) => (
            <span
              key={f.title}
              style={{
                width: i === index ? 16 : 6,
                height: 6,
                borderRadius: 3,
                background: i === index ? COL.blue : COL.track,
                transition: 'width var(--motion-base) ease',
              }}
            />
          ))}
        </div>
        {!reducedMotion && (
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={paused ? 'Play the features' : 'Pause the features'}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <PlayIcon size={14} aria-hidden /> : <PauseIcon size={14} aria-hidden />}
          </ActionIcon>
        )}
      </Group>
    </section>
  )
}
