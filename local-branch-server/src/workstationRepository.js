import crypto from 'node:crypto'
import { config } from './config.js'
import { createId, db, nowIso } from './db.js'

const insertWorkstation = db.prepare(`
  INSERT INTO authorized_workstations (
    id, secret_hash, computer_name, status, first_seen_at, last_seen_at, ip_address
  ) VALUES (?, ?, ?, 'active', ?, ?, ?)
`)
const selectWorkstation = db.prepare('SELECT * FROM authorized_workstations WHERE id = ?')
const countAll = db.prepare('SELECT count(*) FROM authorized_workstations').pluck()
const touchWorkstation = db.prepare(`
  UPDATE authorized_workstations
  SET last_seen_at = ?, last_user_id = COALESCE(?, last_user_id), ip_address = ?
  WHERE id = ?
`)
const listWorkstations = db.prepare(`
  SELECT id, computer_name, status, first_seen_at, last_seen_at, last_user_id,
         ip_address, revoked_at, revoked_by
  FROM authorized_workstations
  ORDER BY last_seen_at DESC
`)
const revokeWorkstation = db.prepare(`
  UPDATE authorized_workstations
  SET status = 'revoked', revoked_at = ?, revoked_by = ?
  WHERE id = ?
`)
const selectEnrollmentToken = db.prepare(`
  SELECT * FROM workstation_enrollment_tokens WHERE token_hash = ?
`)
const insertEnrollmentToken = db.prepare(`
  INSERT INTO workstation_enrollment_tokens (token_hash, created_at, expires_at)
  VALUES (?, ?, ?)
`)
const consumeEnrollmentToken = db.prepare(`
  UPDATE workstation_enrollment_tokens SET used_at = ?
  WHERE token_hash = ? AND used_at IS NULL
`)

const digest = (value) => crypto.createHash('sha256').update(String(value || '')).digest()
const safeDigestEquals = (value, expected) => {
  const actual = digest(value)
  const stored = Buffer.from(String(expected || ''), 'hex')
  return actual.length === stored.length && crypto.timingSafeEqual(actual, stored)
}

const assertEnrollmentToken = (token) => {
  const tokenHash = digest(token).toString('hex')
  let record = selectEnrollmentToken.get(tokenHash)
  if (!record && config.workstationEnrollmentToken && safeDigestEquals(token, digest(config.workstationEnrollmentToken).toString('hex'))) {
    const now = nowIso()
    insertEnrollmentToken.run(
      tokenHash,
      now,
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    )
    record = selectEnrollmentToken.get(tokenHash)
  }
  if (
    !record ||
    record.used_at ||
    new Date(record.expires_at).getTime() <= Date.now()
  ) {
    throw Object.assign(new Error('Workstation enrollment token is invalid.'), { status: 401 })
  }
  if (!consumeEnrollmentToken.run(nowIso(), tokenHash).changes) {
    throw Object.assign(new Error('Workstation enrollment token has already been used.'), { status: 401 })
  }
}

export const createWorkstationEnrollmentToken = (ttlMinutes = 30) => {
  const token = crypto.randomBytes(32).toString('base64url')
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + Math.min(Math.max(ttlMinutes, 5), 120) * 60 * 1000).toISOString()
  insertEnrollmentToken.run(digest(token).toString('hex'), createdAt, expiresAt)
  return { token, createdAt, expiresAt }
}

export const enrollWorkstation = ({ enrollmentToken, computerName, ipAddress }) => {
  assertEnrollmentToken(enrollmentToken)
  const normalizedName = String(computerName || '').trim().slice(0, 120)
  if (!normalizedName) throw Object.assign(new Error('Computer name is required.'), { status: 400 })
  const id = createId()
  const secret = crypto.randomBytes(32).toString('base64url')
  const timestamp = nowIso()
  insertWorkstation.run(
    id,
    digest(secret).toString('hex'),
    normalizedName,
    timestamp,
    timestamp,
    String(ipAddress || '').slice(0, 100)
  )
  return { id, secret, computerName: normalizedName, enrolledAt: timestamp }
}

export const requireAuthorizedWorkstation = (request, response, next) => {
  if (countAll.get() === 0) {
    next()
    return
  }
  const id = String(request.get('x-healthflow-workstation-id') || '').trim()
  const secret = String(request.get('x-healthflow-workstation-secret') || '').trim()
  const workstation = id ? selectWorkstation.get(id) : null
  if (
    !workstation ||
    workstation.status !== 'active' ||
    !safeDigestEquals(secret, workstation.secret_hash)
  ) {
    response.status(401).json({ error: 'This workstation is not enrolled or has been revoked.' })
    return
  }
  request.workstation = workstation
  touchWorkstation.run(
    nowIso(),
    request.branchUser?.userId || null,
    String(request.ip || '').slice(0, 100),
    id
  )
  next()
}

export const listAuthorizedWorkstations = () => listWorkstations.all()

export const revokeAuthorizedWorkstation = ({ id, actorUserId }) => {
  const result = revokeWorkstation.run(nowIso(), actorUserId || null, id)
  if (!result.changes) throw Object.assign(new Error('Workstation was not found.'), { status: 404 })
  return selectWorkstation.get(id)
}
