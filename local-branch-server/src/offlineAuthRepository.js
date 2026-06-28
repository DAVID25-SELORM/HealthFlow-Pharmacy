import crypto from 'node:crypto'
import { createId, db, getBranchMeta, nowIso, parseJson, setBranchMeta } from './db.js'

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MINUTES = 15
const PIN_PATTERN = /^\d{6,12}$/
const offlineAuthError = (message, status) => Object.assign(new Error(message), { status })

const selectUserById = db.prepare('SELECT * FROM users WHERE id = ?')
const selectUserByEmail = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1')
const listUsers = db.prepare(`
  SELECT id, email, full_name, role, assigned_roles_json, organization_id, branch_id,
         permissions_json, is_active,
         offline_access_enabled, offline_pin_updated_at, offline_failed_attempts,
         offline_locked_until
  FROM users
  ORDER BY full_name, email
`)
const updatePin = db.prepare(`
  UPDATE users
  SET offline_pin_salt = ?, offline_pin_hash = ?, offline_pin_updated_at = ?,
      offline_failed_attempts = 0, offline_locked_until = NULL
  WHERE id = ?
`)
const updateAccess = db.prepare(`
  UPDATE users
  SET offline_access_enabled = ?,
      offline_pin_salt = CASE WHEN ? = 0 THEN NULL ELSE offline_pin_salt END,
      offline_pin_hash = CASE WHEN ? = 0 THEN NULL ELSE offline_pin_hash END,
      offline_pin_updated_at = CASE WHEN ? = 0 THEN NULL ELSE offline_pin_updated_at END,
      offline_failed_attempts = 0,
      offline_locked_until = NULL
  WHERE id = ?
`)
const clearPin = db.prepare(`
  UPDATE users
  SET offline_pin_salt = NULL, offline_pin_hash = NULL, offline_pin_updated_at = NULL,
      offline_failed_attempts = 0, offline_locked_until = NULL
  WHERE id = ?
`)
const recordFailure = db.prepare(`
  UPDATE users
  SET offline_failed_attempts = ?,
      offline_locked_until = ?
  WHERE id = ?
`)
const clearFailures = db.prepare(`
  UPDATE users SET offline_failed_attempts = 0, offline_locked_until = NULL WHERE id = ?
`)
const insertAudit = db.prepare(`
  INSERT INTO local_audit_logs (
    id, event_type, actor_user_id, target_user_id, success, detail, ip_address, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const listAudit = db.prepare(`
  SELECT * FROM local_audit_logs
  ORDER BY created_at DESC
  LIMIT ?
`)

const getFacilityServerId = () => {
  let serverId = getBranchMeta('offline_auth_server_id')
  if (!serverId) {
    serverId = crypto.randomUUID()
    setBranchMeta('offline_auth_server_id', serverId)
  }
  return serverId
}

const hashPin = (pin, salt) =>
  crypto.scryptSync(`${getFacilityServerId()}:${pin}`, salt, 32).toString('base64')

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''), 'base64')
  const rightBuffer = Buffer.from(String(right || ''), 'base64')
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

const audit = ({ eventType, actorUserId = null, targetUserId = null, success, detail = '', ipAddress = '' }) => {
  insertAudit.run(
    createId(), eventType, actorUserId, targetUserId, success ? 1 : 0,
    String(detail || '').slice(0, 500), String(ipAddress || '').slice(0, 100), nowIso()
  )
}

const publicUser = (row) => {
  const organizations = parseJson(getBranchMeta('organization_snapshot'), []) || []
  const branches = parseJson(getBranchMeta('branches_snapshot'), []) || []
  return ({
  id: row.id,
  email: row.email,
  fullName: row.full_name,
  role: row.role,
  assignedRoles: parseJson(row.assigned_roles_json, [row.role].filter(Boolean)),
  organizationId: row.organization_id,
  branchId: row.branch_id,
  permissions: parseJson(row.permissions_json, {}),
  isActive: row.is_active !== 0,
  offlineAccessEnabled: row.offline_access_enabled === 1,
  offlinePinEnrolled: Boolean(row.offline_pin_hash),
  offlinePinUpdatedAt: row.offline_pin_updated_at,
  offlineLockedUntil: row.offline_locked_until,
  organization: organizations[0] || null,
  branch: branches.find(
    (branch) => branch.id === row.branch_id
  ) || null,
  })
}

export const listOfflineAccessUsers = () => listUsers.all().map(publicUser)

export const setOfflineAccess = ({ targetUserId, enabled, actorUserId, ipAddress }) => {
  const user = selectUserById.get(targetUserId)
  if (!user) throw new Error('Staff member was not found in the local staff snapshot.')
  updateAccess.run(enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 1 : 0, targetUserId)
  audit({
    eventType: enabled ? 'offline_access.enabled' : 'offline_access.revoked',
    actorUserId, targetUserId, success: true, ipAddress,
  })
  return publicUser(selectUserById.get(targetUserId))
}

export const resetOfflinePin = ({ targetUserId, actorUserId, ipAddress }) => {
  const user = selectUserById.get(targetUserId)
  if (!user) throw new Error('Staff member was not found in the local staff snapshot.')
  clearPin.run(targetUserId)
  audit({ eventType: 'offline_pin.reset', actorUserId, targetUserId, success: true, ipAddress })
  return publicUser(selectUserById.get(targetUserId))
}

export const enrollOfflinePin = ({ userId, pin, ipAddress }) => {
  const user = selectUserById.get(userId)
  if (!user || user.is_active === 0) throw offlineAuthError('Active staff profile is unavailable locally.', 403)
  if (user.offline_access_enabled !== 1) throw offlineAuthError('An administrator must enable offline PIN access first.', 403)
  if (!PIN_PATTERN.test(String(pin || ''))) throw offlineAuthError('Offline PIN must contain 6 to 12 digits.', 400)
  const salt = crypto.randomBytes(16).toString('base64')
  updatePin.run(salt, hashPin(pin, salt), nowIso(), userId)
  audit({ eventType: 'offline_pin.enrolled', actorUserId: userId, targetUserId: userId, success: true, ipAddress })
  return publicUser(selectUserById.get(userId))
}

export const authenticateOfflinePin = ({ email, pin, ipAddress }) => {
  const user = selectUserByEmail.get(String(email || '').trim())
  const now = Date.now()
  if (!user) {
    crypto.scryptSync(`unknown:${pin || ''}`, crypto.randomBytes(16), 32)
    audit({ eventType: 'offline_login.failed', success: false, detail: 'Unknown staff email.', ipAddress })
    throw offlineAuthError('Offline email or PIN is invalid.', 401)
  }

  const lockedUntil = user.offline_locked_until ? new Date(user.offline_locked_until).getTime() : 0
  if (lockedUntil > now) {
    audit({ eventType: 'offline_login.locked', targetUserId: user.id, success: false, ipAddress })
    throw offlineAuthError('Offline access is temporarily locked after repeated failed attempts.', 423)
  }
  if (
    user.is_active === 0 ||
    user.offline_access_enabled !== 1 ||
    !user.offline_pin_salt ||
    !user.offline_pin_hash
  ) {
    audit({ eventType: 'offline_login.failed', targetUserId: user.id, success: false, detail: 'Offline access unavailable.', ipAddress })
    throw offlineAuthError('Offline email or PIN is invalid.', 401)
  }

  const valid = PIN_PATTERN.test(String(pin || '')) &&
    safeEqual(hashPin(pin, user.offline_pin_salt), user.offline_pin_hash)
  if (!valid) {
    const attempts = Number(user.offline_failed_attempts || 0) + 1
    const nextLock = attempts >= MAX_FAILED_ATTEMPTS
      ? new Date(now + LOCKOUT_MINUTES * 60 * 1000).toISOString()
      : null
    recordFailure.run(nextLock ? 0 : attempts, nextLock, user.id)
    audit({
      eventType: nextLock ? 'offline_login.locked' : 'offline_login.failed',
      targetUserId: user.id, success: false,
      detail: nextLock ? `Locked for ${LOCKOUT_MINUTES} minutes.` : `Failed attempt ${attempts}.`,
      ipAddress,
    })
    throw offlineAuthError(nextLock
      ? 'Offline access is temporarily locked after repeated failed attempts.'
      : 'Offline email or PIN is invalid.', nextLock ? 423 : 401)
  }

  clearFailures.run(user.id)
  audit({ eventType: 'offline_login.succeeded', actorUserId: user.id, targetUserId: user.id, success: true, ipAddress })
  return publicUser(selectUserById.get(user.id))
}

export const listOfflineAuthAudit = (limit = 100) =>
  listAudit.all(Math.min(Math.max(Number(limit) || 100, 1), 500))

export const getOfflineAuthStatus = (userId) => {
  const user = selectUserById.get(userId)
  return user ? publicUser(user) : null
}
