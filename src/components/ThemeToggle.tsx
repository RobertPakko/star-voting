import {
  ActionIcon,
  Menu,
  Text,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core'
import { MoonIcon, SunIcon } from '@phosphor-icons/react'

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
          {computed === 'dark' ? (
            <MoonIcon size={18} aria-hidden />
          ) : (
            <SunIcon size={18} aria-hidden />
          )}
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
