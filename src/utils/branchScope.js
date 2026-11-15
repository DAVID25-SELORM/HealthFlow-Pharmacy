// BRANCH-001: at a pharmacy with Multi-branch switched on, a member of staff who belongs to a branch
// sees that branch's stock, sales and alerts only. Administrators (and platform super administrators)
// keep the organisation-wide view, and a pharmacy without Multi-branch is unchanged: its staff may
// carry a branch id but everything is one branch.
const ORGANISATION_WIDE_ROLES = ['admin', 'super_admin']

// Returns the branch id to filter by, or '' when the whole organisation may be shown.
export const getBranchScopeId = ({ profile, role, multiBranchEnabled = false } = {}) => {
  if (!multiBranchEnabled) return ''
  const branchId = String(profile?.branch_id ?? '').trim()
  if (!branchId) return ''
  return ORGANISATION_WIDE_ROLES.includes(String(role ?? '').trim().toLowerCase()) ? '' : branchId
}
