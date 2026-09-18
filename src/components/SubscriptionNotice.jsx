import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { hasSubscriptionVisibility, subscriptionNotice } from '../utils/subscriptionLifecycle'
import './SubscriptionNotice.css'

export default function SubscriptionNotice() {
  const { role, assignedRoles } = useAuth()
  const [subscription, setSubscription] = useState(null)
  useEffect(() => {
    if (!hasSubscriptionVisibility(role, assignedRoles)) return undefined
    let active = true
    supabase.rpc('get_my_subscription').then(({ data }) => { if (active) setSubscription(data || null) })
      .catch(() => {})
    return () => { active = false }
  }, [role, assignedRoles])
  const notice = subscriptionNotice(subscription)
  if (!notice) return null
  return <aside className={`subscription-notice ${notice.tone}`} role="status">
    <strong>{notice.title}</strong><span>{notice.message}</span>
  </aside>
}
