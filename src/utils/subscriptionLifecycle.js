export const SUBSCRIPTION_VISIBLE_ROLES = new Set(['admin', 'pharmacist', 'super_admin'])

export const hasSubscriptionVisibility = (role, assignedRoles = []) => {
  const roles = [role, ...(Array.isArray(assignedRoles) ? assignedRoles : [])]
    .map((value) => String(value || '').trim().toLowerCase())
  return roles.some((value) => SUBSCRIPTION_VISIBLE_ROLES.has(value))
}

export const subscriptionNotice = (subscription) => {
  const state = String(subscription?.state || '').toLowerCase()
  if (state === 'grace') return {
    tone: 'warning',
    title: 'Subscription renewal',
    message: `Your subscription has expired, but your facility is operating normally during the grace period${subscription.grace_ends_at ? ` until ${new Date(subscription.grace_ends_at).toLocaleDateString()}` : ''}. Please renew.`,
  }
  if (state === 'overdue') return {
    tone: 'warning',
    title: 'Subscription overdue',
    message: 'Core pharmacy and NHIS operations continue. Some non-essential features may be restricted. Please renew to restore full access.',
  }
  return null
}
