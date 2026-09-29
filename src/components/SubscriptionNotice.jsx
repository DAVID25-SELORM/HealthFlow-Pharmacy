import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { hasSubscriptionVisibility, subscriptionNotice } from '../utils/subscriptionLifecycle'
import './SubscriptionNotice.css'

export default function SubscriptionNotice() {
  const { role, assignedRoles, user, profile, organization, loading } = useAuth()
  const [subscription, setSubscription] = useState(null)
  const userId = user?.id
  const organizationId = organization?.id
  const profileOrganizationId = profile?.organization_id
  const canView = hasSubscriptionVisibility(role, assignedRoles)
  const canFetch = !loading && Boolean(userId && organizationId && profileOrganizationId === organizationId)
    && profile?.is_active !== false && canView
  useEffect(() => {
    setSubscription(null)
    if (!canFetch) return undefined
    let active = true
    Promise.resolve(supabase.rpc('get_my_subscription')).then(({ data, error }) => {
      if (active && !error) setSubscription({ userId, organizationId, data })
    })
      .catch(() => {})
    return () => { active = false }
  }, [canFetch, userId, organizationId])
  const notice = canFetch && subscription?.userId === userId && subscription?.organizationId === organizationId
    ? subscriptionNotice(subscription.data) : null
  if (!notice) return null
  return <aside className={`subscription-notice ${notice.tone}`} role="status">
    <strong>{notice.title}</strong><span>{notice.message}</span>
  </aside>
}
