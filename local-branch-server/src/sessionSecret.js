// The secret that signs staff sessions. It is made on this server, kept in its own file beside the database, and is
// never sent anywhere. It is deliberately not BRANCH_SERVER_TOKEN: that key is copied into scripts, setup codes and
// sometimes a browser, and whoever held it could otherwise sign a session as any member of staff.
// A database backup copies only the database, so the secret is not in backups.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const SECRET_FILE_NAME = 'session-signing.key'
// 32 random bytes written as base64url.
const SECRET_LENGTH = 43

export const getSessionSecretPath = (databasePath = config.sqlitePath) =>
  path.join(path.dirname(databasePath), SECRET_FILE_NAME)

export const loadOrCreateSessionSecret = (filePath) => {
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim()
    if (existing.length >= SECRET_LENGTH) return existing
  } catch (error) {
    // Any other problem stops here: replacing a file that only could not be read would sign everyone out.
    if (error.code !== 'ENOENT') throw error
  }

  const secret = crypto.randomBytes(32).toString('base64url')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, secret, { encoding: 'utf8', mode: 0o600 })
  return secret
}

let cached = ''

export const getSessionSecret = () => {
  cached = cached || loadOrCreateSessionSecret(getSessionSecretPath())
  return cached
}
