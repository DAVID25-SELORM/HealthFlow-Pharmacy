import { createContext, useContext, useMemo } from 'react'
import { useAuth } from './AuthContext'

/**
 * TenantContext provides organization-level utilities
 * Wraps the app to ensure all operations are scoped to the user's organization
 */

const TenantContext = createContext(null)

export const TenantProvider = ({ children }) => {
  const { organization, loading } = useAuth()

  const value = useMemo(() => {
    if (loading) {
      return {
        organization: null,
        organizationId: null,
        isTrialActive: false,
        isSubscriptionActive: false,
        isSuspended: false,
        daysUntilTrialExpires: null,
        loading: true,
      }
    }

    if (!organization) {
      return {
        organization: null,
        organizationId: null,
        isTrialActive: false,
        isSubscriptionActive: false,
        isSuspended: false,
        daysUntilTrialExpires: null,
        loading: false,
      }
    }

    // Calculate trial status
    const now = new Date()
    const trialEnds = organization.trial_ends_at ? new Date(organization.trial_ends_at) : null
    const isTrialActive = 
      organization.status === 'trial' && 
      trialEnds && 
      trialEnds > now

    const daysUntilTrialExpires = trialEnds 
      ? Math.ceil((trialEnds - now) / (1000 * 60 * 60 * 24))
      : null

    // Calculate subscription status
    const subscriptionEnds = organization.subscription_ends_at 
      ? new Date(organization.subscription_ends_at) 
      : null
    const isSubscriptionActive = 
      organization.status === 'active' && 
      organization.subscription_tier !== 'trial' &&
      (!subscriptionEnds || subscriptionEnds > now)

    const isSuspended = organization.status === 'suspended'

    return {
      organization,
      organizationId: organization.id,
      isTrialActive,
      isSubscriptionActive,
      isSuspended,
      daysUntilTrialExpires,
      loading: false,
    }
  }, [organization, loading])

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
}

export const useTenant = () => {
  const context = useContext(TenantContext)
  if (!context) {
    throw new Error('useTenant must be used within TenantProvider')
  }
  return context
}

/**
 * Hook to get organization ID
 * Useful for ensuring all operations include organization_id
 */
export const useOrganizationId = () => {
  const { organizationId } = useTenant()
  return organizationId
}

/**
 * Hook to check if organization subscription is valid
 */
export const useSubscriptionStatus = () => {
  const { isTrialActive, isSubscriptionActive, isSuspended, daysUntilTrialExpires } = useTenant()
  
  return {
    isActive: isTrialActive || isSubscriptionActive,
    isTrial: isTrialActive,
    isSubscribed: isSubscriptionActive,
    isSuspended,
    daysUntilTrialExpires,
  }
}
