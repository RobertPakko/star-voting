import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { currentSubscription, rememberAccountPush } from './push'

/**
 * An account's notification settings, and whether the browser asking is one
 * of its devices — one read, `my_notification_settings`, for both.
 *
 * Read by NotificationSwitches, which the header's gear menu and the
 * /settings page both draw. It also refreshes the local mirror of the
 * account's push setting that a poll page reads to decide whether to point at
 * that menu (`accountPushHere`).
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
    rememberAccountPush(answer?.push ?? true)
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
