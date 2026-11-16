// BRANCH-001: at a pharmacy with Multi-branch switched on, a member of staff who belongs to a branch
// sees that branch's stock, sales and alerts only. Administrators (and platform super administrators)
// keep the organisation-wide view, and a pharmacy without Multi-branch is unchanged: its staff may
// carry a branch id but everything is one branch.
const ORGANISATION_WIDE_ROLES = ['admin', 'super_admin']

// A pharmacy with only one active branch has nothing to keep apart, and its stock may still carry no
// branch at all (older pharmacies), so it is never limited. `activeBranchCount` is null while it is not
// known yet; until it is known the member of staff is limited (the safe side), then released if the
// pharmacy turns out to have one branch.
//
// Returns the branch id to filter by, or '' when the whole organisation may be shown.
export const getBranchScopeId = ({ profile, role, multiBranchEnabled = false, activeBranchCount = null } = {}) => {
  if (!multiBranchEnabled) return ''
  if (Number.isFinite(activeBranchCount) && activeBranchCount <= 1) return ''
  const branchId = String(profile?.branch_id ?? '').trim()
  if (!branchId) return ''
  return ORGANISATION_WIDE_ROLES.includes(String(role ?? '').trim().toLowerCase()) ? '' : branchId
}
