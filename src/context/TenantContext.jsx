import { createContext, useContext, useMemo } from 'react'
import { useAuth } from './AuthContext'
import {
  normalizeSubscriptionTier,
  resolveTierAccess,
  TIER_LIMITS,
} from '../utils/subscription'

export { normalizeSubscriptionTier, TIER_LIMITS }

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
        planCode: 'starter',
        billingStatus: 'trial',
        supportLevel: 'standard',
        canUseClaims: false,
        canUsePurchases: false,
        canUseNhis: false,
        canUseNhisTopups: false,
        canUseAccounting: false,
        canUseMultiBranch: false,
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
        planCode: 'starter',
        billingStatus: 'trial',
        supportLevel: 'standard',
        canUseClaims: false,
        canUsePurchases: false,
        canUseNhis: false,
        canUseNhisTopups: false,
        canUseAccounting: false,
        canUseMultiBranch: false,
        loading: false,
      }
    }

    const {
      isTrialActive,
      isSubscriptionActive,
      isSuspended,
      daysUntilTrialExpires,
      tierLimits,
    } = resolveTierAccess(organization)

    return {
      organization,
      organizationId: organization.id,
      isTrialActive,
      isSubscriptionActive,
      isSuspended,
      daysUntilTrialExpires,
      tierLimits,
      planCode: organization.plan_code || 'starter',
      billingStatus: organization.billing_status || organization.status || 'trial',
      supportLevel: organization.support_level || 'standard',
      loading: false,
      canUseClaims: Boolean(organization.can_use_claims),
      canUsePurchases: Boolean(organization.can_use_purchases),
      canUseNhis: Boolean(organization.can_use_nhis),
      canUseNhisTopups: Boolean(organization.can_use_nhis_topups),
      canUseAccounting: Boolean(organization.can_use_accounting),
      canUseMultiBranch: Boolean(organization.can_use_multi_branch),
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
