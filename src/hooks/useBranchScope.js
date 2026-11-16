import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useTenant } from '../context/TenantContext'
import { getActiveBranchCount } from '../services/branchService'
import { getBranchScopeId } from '../utils/branchScope'

// BRANCH-001: the branch a member of staff is limited to ('' = the whole pharmacy). The number of active
// branches is read once per pharmacy for the session; until it is known, a branch member of staff is
// limited, and a pharmacy that turns out to have a single branch is released.
const branchCountByOrganization = new Map()

export const resetBranchCountCacheForTests = () => branchCountByOrganization.clear()

export const useBranchScope = () => {
  const { profile, role } = useAuth()
  const { canUseMultiBranch } = useTenant()
  const organizationId = profile?.organization_id || ''
  // Only staff who could be limited need the count (administrators, staff with no branch and pharmacies
  // without Multi-branch are never limited, so nothing is read for them).
  const couldBeLimited = Boolean(getBranchScopeId({ profile, role, multiBranchEnabled: canUseMultiBranch, activeBranchCount: 2 }))
  const needsCount = Boolean(couldBeLimited && organizationId)
  const [activeBranchCount, setActiveBranchCount] = useState(() =>
    organizationId && branchCountByOrganization.has(organizationId) ? branchCountByOrganization.get(organizationId) : null
  )

  useEffect(() => {
    if (!needsCount) return undefined
    if (branchCountByOrganization.has(organizationId)) {
      setActiveBranchCount(branchCountByOrganization.get(organizationId))
      return undefined
    }
    let active = true
    getActiveBranchCount()
      .then((count) => {
        branchCountByOrganization.set(organizationId, count)
        if (active) setActiveBranchCount(count)
      })
      .catch((error) => {
        // Unknown stays limited (the safe side).
        console.warn('Unable to count active branches; keeping the branch limit on.', error)
      })
    return () => { active = false }
  }, [needsCount, organizationId])

  return getBranchScopeId({ profile, role, multiBranchEnabled: canUseMultiBranch, activeBranchCount })
}
