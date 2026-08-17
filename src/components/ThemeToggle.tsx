import { ActionIcon, Menu, Text, useComputedColorScheme, useMantineColorScheme } from '@mantine/core'

const OPTIONS = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['auto', 'System'],
] as const

/**
 * Light / dark / system, as a menu rather than a two-way switch: the app
 * defaults to following the OS, and a plain toggle gives no way back to that
 * once you've touched it.
 *
 * Mantine persists the choice to localStorage on its own. The inline script
 * in index.html is what stops a dark-mode reader seeing a white flash while
 * the bundle loads.
 */
export function ThemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme()

  // Read the media query during render rather than in an effect, so the icon
  // is right on the first paint instead of flipping a frame later.
  const computed = useComputedColorScheme('light', { getInitialValueInEffect: false })

  return (
    <Menu width={150} position="bottom-end" shadow="md">
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Color theme">
          {computed === 'dark' ? <MoonIcon /> : <SunIcon />}
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {OPTIONS.map(([value, label]) => (
          <Menu.Item
            key={value}
            onClick={() => setColorScheme(value)}
            rightSection={
              colorScheme === value ? (
                <Text size="xs" c="dimmed">
                  ✓
                </Text>
              ) : null
            }
          >
            {label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}
