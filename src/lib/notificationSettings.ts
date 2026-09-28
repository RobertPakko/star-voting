import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { currentSubscription } from './push'

/**
 * An account's notification settings, and whether the browser asking is one
 * of its devices — one read, `my_notification_settings`, for both.
 *
 * Shared by the settings page and the install guide, which both draw the
 * "this device" control and would otherwise each ask the same thing their own
 * way.
 */
export type NotificationSettings = {
  email: boolean
  push: boolean
  /** Whether this browser's subscription is bound to this account. */
  thisDevice: boolean
}

export function useNotificationSettings(userId: string | null) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) return
    // The endpoint is local — no request — and it is what lets the one read
    // below answer for this device as well as for the account.
    const subscription = await currentSubscription().catch(() => null)
    const { data, error: readError } = await supabase.rpc('my_notification_settings', {
      p_endpoint: subscription?.endpoint,
    })
    if (readError) {
      setError(readError.message)
      return
    }
    const answer = data as { email?: boolean; push?: boolean; this_device?: boolean } | null
    setError(null)
    setSettings({
      email: answer?.email ?? true,
      push: answer?.push ?? true,
      thisDevice: answer?.this_device ?? false,
    })
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  return { settings, setSettings, error, reload: load }
}
