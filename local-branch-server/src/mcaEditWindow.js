// Pure, side-effect-free helpers for the MCA (Medicine Counter Assistant) edit window.
//
// Policy:
//   - An MCA may edit / add / remove medications on a claim only while the edit
//     window is open.
//   - The window is open for 24 hours from the claim's created_at.
//   - A higher role (admin / claims officer) may re-open it for a further 12
//     hours by stamping mca_edit_reopened_until.
//
// These helpers do not touch CC-code generation, claim submission, validation,
// or any existing claim logic — they only answer "is the MCA window open?".

export const MCA_EDIT_WINDOW_HOURS = 24
export const MCA_EDIT_REOPEN_HOURS = 12
const HOUR_MS = 60 * 60 * 1000

const toTime = (value) => {
  if (!value) return NaN
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : NaN
}

// Roles permitted to re-open the MCA edit window.
export const MCA_EDIT_REOPEN_ROLES = ['admin', 'super_admin', 'claims_officer']

export const canReopenMcaEditWindow = (role) =>
  MCA_EDIT_REOPEN_ROLES.includes(String(role || '').trim().toLowerCase())

// Is the MCA edit window currently open for this claim?
export const isMcaEditWindowOpen = (claim = {}, now = Date.now()) => {
  const createdAt = toTime(claim.created_at || claim.createdAt)
  if (Number.isFinite(createdAt) && now - createdAt < MCA_EDIT_WINDOW_HOURS * HOUR_MS) {
    return true
  }
  const reopenedUntil = toTime(claim.mca_edit_reopened_until || claim.mcaEditReopenedUntil)
  if (Number.isFinite(reopenedUntil) && now < reopenedUntil) {
    return true
  }
  return false
}

// Build the fields that re-open the window for a further MCA_EDIT_REOPEN_HOURS.
export const buildMcaEditReopenFields = ({ reason, reopenedBy, now = Date.now() } = {}) => ({
  mca_edit_reopened_until: new Date(now + MCA_EDIT_REOPEN_HOURS * HOUR_MS).toISOString(),
  mca_edit_reopen_reason: String(reason || '').trim(),
  mca_edit_reopened_by: String(reopenedBy || '').trim() || null,
  mca_edit_reopened_at: new Date(now).toISOString(),
})
