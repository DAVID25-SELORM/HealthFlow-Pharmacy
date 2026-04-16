import { createContext, useContext, useMemo } from 'react'
import { useAuth } from './AuthContext'

/**
 * TenantContext provides organization-level utilities
 * and normalizes subscription tiers for feature gating.
 */

export const normalizeSubscriptionTier = (tier) => {
  const normalized = String(tier || '').trim().toLowerCase()

  if (normalized === 'standard' || normalized === 'professional' || normalized === 'pro') {
    return 'pro'
  }

  if (normalized === 'free') {
    return 'basic'
  }

  if (normalized === 'trial' || normalized === 'basic' || normalized === 'enterprise') {
    return normalized
  }

  return 'basic'
}

export const TIER_LIMITS = {
  basic: {
    maxUsers: 3,
    maxDrugs: 200,
    hasReports: false,
    hasClaims: false,
    hasAdvancedInventory: false,
    label: 'Basic',
  },
  pro: {
    maxUsers: 10,
    maxDrugs: 1000,
    hasReports: true,
    hasClaims: false,
    hasAdvancedInventory: true,
    label: 'Professional',
  },
  enterprise: {
    maxUsers: Infinity,
    maxDrugs: Infinity,
    hasReports: true,
    hasClaims: true,
    hasAdvancedInventory: true,
    label: 'Enterprise',
  },
}

// During trial, grant professional-level access.
const TRIAL_LIMITS = TIER_LIMITS.pro

const getTierLimits = (tier, isTrialActive) => {
  if (isTrialActive) return TRIAL_LIMITS
  return TIER_LIMITS[normalizeSubscriptionTier(tier)] || TIER_LIMITS.basic
}

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
        tierLimits: TIER_LIMITS.basic,
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
        tierLimits: TIER_LIMITS.basic,
        loading: false,
      }
    }

    const now = new Date()
    const trialEnds = organization.trial_ends_at ? new Date(organization.trial_ends_at) : null
    const normalizedTier = normalizeSubscriptionTier(organization.subscription_tier)
    const isTrialActive = organization.status === 'trial' && trialEnds && trialEnds > now

    const daysUntilTrialExpires = trialEnds
      ? Math.ceil((trialEnds - now) / (1000 * 60 * 60 * 24))
      : null

    const subscriptionEnds = organization.subscription_ends_at
      ? new Date(organization.subscription_ends_at)
      : null
    const isSubscriptionActive =
      organization.status === 'active' &&
      normalizedTier !== 'trial' &&
      (!subscriptionEnds || subscriptionEnds > now)

    const isSuspended = organization.status === 'suspended'
    const tierLimits = getTierLimits(normalizedTier, isTrialActive)

    return {
      organization,
      organizationId: organization.id,
      isTrialActive,
      isSubscriptionActive,
      isSuspended,
      daysUntilTrialExpires,
      tierLimits,
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
 * Hook to get organization ID.
 */
export const useOrganizationId = () => {
  const { organizationId } = useTenant()
  return organizationId
}

/**
 * Hook to check whether the organization subscription is valid.
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
