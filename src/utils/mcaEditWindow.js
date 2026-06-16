// Pure helpers for the MCA (Medicine Counter Assistant) medication edit window.
// Mirrors local-branch-server/src/mcaEditWindow.js. The server is the source of
// truth and enforces this; the frontend uses it only to show/hide controls and
// give early feedback. Touches no CC-code, submission, or validation logic.

export const MCA_EDIT_WINDOW_HOURS = 24
export const MCA_EDIT_REOPEN_HOURS = 12
const HOUR_MS = 60 * 60 * 1000

const toTime = (value) => {
  if (!value) return NaN
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : NaN
}

export const MCA_EDIT_REOPEN_ROLES = ['admin', 'super_admin', 'claims_officer']

export const canReopenMcaEditWindow = (role) =>
  MCA_EDIT_REOPEN_ROLES.includes(String(role || '').trim().toLowerCase())

export const isMcaEditWindowOpen = (claim = {}, now = Date.now()) => {
  const createdAt = toTime(claim?.created_at || claim?.createdAt)
  if (Number.isFinite(createdAt) && now - createdAt < MCA_EDIT_WINDOW_HOURS * HOUR_MS) {
    return true
  }
  const reopenedUntil = toTime(claim?.mca_edit_reopened_until || claim?.mcaEditReopenedUntil)
  if (Number.isFinite(reopenedUntil) && now < reopenedUntil) {
    return true
  }
  return false
}
