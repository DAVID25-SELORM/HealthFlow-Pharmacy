import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { hasSubscriptionVisibility, subscriptionNotice } from '../utils/subscriptionLifecycle'
import './SubscriptionNotice.css'
import PlatformBilling from './PlatformBilling'

export default function SubscriptionNotice() {
  const { role, assignedRoles, profile } = useAuth()
  const organizationId = profile?.organization_id
  const [subscription, setSubscription] = useState(null)
  useEffect(() => {
    setSubscription(null)
    // This RPC describes a facility subscription, not the platform account.
    if (!organizationId || !hasSubscriptionVisibility(role, assignedRoles)) return undefined
    let active = true
    supabase.rpc('get_my_subscription').then(({ data }) => { if (active) setSubscription(data || null) })
      .catch(() => {})
    return () => { active = false }
  }, [role, assignedRoles, organizationId])
  const notice = subscriptionNotice(subscription)
  if (!notice) return <PlatformBilling />
  return <><PlatformBilling /><aside className={`subscription-notice ${notice.tone}`} role="status">
    <strong>{notice.title}</strong><span>{notice.message}</span>
  </aside></>
}
