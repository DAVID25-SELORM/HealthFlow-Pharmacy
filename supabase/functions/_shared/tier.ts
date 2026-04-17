const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const TIER_LIMITS = {
  basic: {
    maxUsers: 3,
    maxDrugs: 200,
    hasReports: false,
    hasClaims: false,
    hasAdvancedInventory: false,
  },
  pro: {
    maxUsers: 10,
    maxDrugs: 1000,
    hasReports: true,
    hasClaims: false,
    hasAdvancedInventory: true,
  },
  enterprise: {
    maxUsers: Number.POSITIVE_INFINITY,
    maxDrugs: Number.POSITIVE_INFINITY,
    hasReports: true,
    hasClaims: true,
    hasAdvancedInventory: true,
  },
} as const

export type EffectiveTierKey = keyof typeof TIER_LIMITS
export type TierKey = EffectiveTierKey | 'trial'

const parseOptionalDate = (value: unknown) => {
  const normalized = normalizeText(value)
  if (!normalized) {
    return null
  }

  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export const normalizeSubscriptionTier = (
  value: unknown,
  fallback: TierKey = 'basic'
): TierKey => {
  const normalized = normalizeText(value).toLowerCase()
  const mapped =
    normalized === 'standard' || normalized === 'professional'
      ? 'pro'
      : normalized === 'free'
        ? 'basic'
        : normalized

  if (!mapped) {
    return fallback
  }

  if (mapped === 'trial' || mapped === 'basic' || mapped === 'pro' || mapped === 'enterprise') {
    return mapped
  }

  return fallback
}

export const resolveTierAccess = (organization: {
  status?: unknown
  subscription_tier?: unknown
  trial_ends_at?: unknown
  subscription_ends_at?: unknown
}) => {
  const now = new Date()
  const normalizedTier = normalizeSubscriptionTier(organization.subscription_tier)
  const status = normalizeText(organization.status).toLowerCase()
  const trialEndsAt = parseOptionalDate(organization.trial_ends_at)
  const subscriptionEndsAt = parseOptionalDate(organization.subscription_ends_at)

  const isTrialActive =
    status === 'trial' && Boolean(trialEndsAt) && trialEndsAt.getTime() > now.getTime()
  const isSubscriptionActive =
    status === 'active' &&
    normalizedTier !== 'trial' &&
    (!subscriptionEndsAt || subscriptionEndsAt.getTime() > now.getTime())

  const effectiveTier: EffectiveTierKey =
    isTrialActive && normalizedTier === 'enterprise'
      ? 'enterprise'
      : isTrialActive
        ? 'pro'
        : normalizedTier === 'trial'
          ? 'basic'
          : (normalizedTier as EffectiveTierKey)

  return {
    normalizedTier,
    effectiveTier,
    isTrialActive,
    isSubscriptionActive,
    isSuspended: status === 'suspended',
    tierLimits: TIER_LIMITS[effectiveTier],
  }
}
