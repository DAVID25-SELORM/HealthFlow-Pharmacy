// Asked before a computer is connected to a pharmacy: may it be? The database is only read. It does not load the
// server's configuration, so the setup script can ask before anything is installed or changed.
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { assertDataAllowsConnection } from './dataOwner.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const readConnectedOrganization = (envPath) => {
  if (!envPath || !fs.existsSync(envPath)) return ''
  const match = fs.readFileSync(envPath, 'utf8').match(/^\s*ORGANIZATION_ID\s*=\s*["']?([^"'\r\n#]*)/m)
  const value = String(match?.[1] || '').trim()
  return UUID.test(value) ? value : ''
}

export const assertComputerCanConnect = ({ databasePaths, envPath, organizationId }) => {
  const previousOrganizationId = readConnectedOrganization(envPath)
  const existing = [...new Set(databasePaths.filter(Boolean).map((item) => path.resolve(item)))]
    .filter((item) => fs.existsSync(item))

  for (const databasePath of existing) {
    let db
    try {
      db = new Database(databasePath, { readonly: true, fileMustExist: true })
      assertDataAllowsConnection(db, organizationId, previousOrganizationId)
    } catch (error) {
      if (error.status === 400) throw error
      // Not being able to look is not the same as there being nothing to protect.
      throw Object.assign(
        new Error(`The records on this computer could not be checked, so it was not connected: ${error.message}`),
        { status: 400 }
      )
    } finally {
      db?.close()
    }
  }
}
