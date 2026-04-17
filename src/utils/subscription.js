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

const parseOptionalDate = (value) => {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export const resolveTierAccess = (organization, nowValue = new Date()) => {
  if (!organization) {
    return {
      normalizedTier: 'basic',
      effectiveTier: 'basic',
      isTrialActive: false,
      isSubscriptionActive: false,
      isSuspended: false,
      daysUntilTrialExpires: null,
      tierLimits: TIER_LIMITS.basic,
    }
  }

  const now = nowValue instanceof Date ? nowValue : new Date(nowValue)
  const normalizedTier = normalizeSubscriptionTier(organization.subscription_tier)
  const trialEnds = parseOptionalDate(organization.trial_ends_at)
  const subscriptionEnds = parseOptionalDate(organization.subscription_ends_at)
  const isTrialActive =
    organization.status === 'trial' &&
    Boolean(trialEnds) &&
    trialEnds.getTime() > now.getTime()

  const daysUntilTrialExpires = trialEnds
    ? Math.ceil((trialEnds.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : null

  const isSubscriptionActive =
    organization.status === 'active' &&
    normalizedTier !== 'trial' &&
    (!subscriptionEnds || subscriptionEnds.getTime() > now.getTime())

  const effectiveTier =
    isTrialActive && normalizedTier === 'enterprise'
      ? 'enterprise'
      : isTrialActive
        ? 'pro'
        : normalizedTier === 'trial'
          ? 'basic'
          : normalizedTier

  return {
    normalizedTier,
    effectiveTier,
    isTrialActive,
    isSubscriptionActive,
    isSuspended: organization.status === 'suspended',
    daysUntilTrialExpires,
    tierLimits: TIER_LIMITS[effectiveTier] || TIER_LIMITS.basic,
  }
}
