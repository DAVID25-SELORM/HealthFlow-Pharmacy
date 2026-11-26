// Makes a computer ready for a different pharmacy without deleting anything: the records, backups, logs and old
// settings are moved into an archive folder, and everything that belongs to the old pharmacy is cleared from the
// settings. The service must be stopped first. The caller restricts who can open the archive folder.
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

// Settings that belong to one pharmacy. Product settings (cloud address, update key, certificates, ports) stay.
const FACILITY_SETTING = new RegExp(
  '^(ORGANIZATION_ID|BRANCH_ID|BRANCH_SYNC_TOKEN|BRANCH_SERVER_TOKEN|' +
  'NHIA_(?!BASE_URL$|ELIGIBILITY_BASE_URL$).+|FACILITY_.+|' +
  'CLAIMIT_UPSTREAM_(API_KEY|API_SECRET|BEARER_TOKEN|USERNAME|PASSWORD)|' +
  '(PAYSTACK|HUBTEL|MOMO|SMS)_.+)$'
)

export const countUnsyncedRecords = (databasePath) => {
  if (!fs.existsSync(databasePath)) return 0
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const count = (table, column) => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      return exists
        ? db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE COALESCE(${column}, '') <> 'synced'`).get().total
        : 0
    }
    return count('sync_outbox', 'status') + count('offline_records', 'sync_status')
  } finally {
    db.close()
  }
}

export const clearFacilitySettings = (content) =>
  content
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*([A-Z0-9_]+)\s*=)(.*?)(\r?)$/)
      return match && FACILITY_SETTING.test(match[2]) ? `${match[1]}${match[4]}` : line
    })
    .join('\n')

export const archiveFacilityData = ({ installRoot, allowUnsynced = false, now = new Date() }) => {
  const dataDir = path.join(installRoot, 'data')
  const databasePath = path.join(dataDir, 'healthflow-branch.sqlite')
  const serverDir = path.join(installRoot, 'local-branch-server')
  const envPath = path.join(serverDir, '.env')
  if (!fs.existsSync(databasePath)) throw new Error(`No HealthFlow records were found at ${databasePath}.`)

  const unsynced = countUnsyncedRecords(databasePath)
  if (unsynced > 0 && !allowUnsynced) {
    throw new Error(
      `${unsynced} record(s) have not reached HealthFlow Cloud. Nothing was changed. Connect this computer to the ` +
      'internet and let it finish syncing first.'
    )
  }

  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const archiveDir = path.join(installRoot, 'archive', stamp)
  if (fs.existsSync(archiveDir)) throw new Error(`The archive folder already exists: ${archiveDir}`)
  fs.mkdirSync(archiveDir, { recursive: true })

  const moved = []
  const move = (from, name) => {
    if (!fs.existsSync(from)) return
    fs.renameSync(from, path.join(archiveDir, name))
    moved.push(name)
  }
  // The database first: if it is still in use this fails before anything else has been touched.
  move(databasePath, 'healthflow-branch.sqlite')
  for (const suffix of ['-wal', '-shm']) move(`${databasePath}${suffix}`, `healthflow-branch.sqlite${suffix}`)
  move(path.join(dataDir, 'backups'), 'backups')
  move(path.join(dataDir, 'session-signing.key'), 'session-signing.key')
  move(path.join(installRoot, 'logs'), 'logs')
  move(`${envPath}.before-cloud-connect`, 'env.before-cloud-connect')

  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, path.join(archiveDir, 'env.settings'))
    moved.push('env.settings')
    fs.writeFileSync(envPath, clearFacilitySettings(fs.readFileSync(envPath, 'utf8')), 'utf8')
  }
  fs.mkdirSync(path.join(installRoot, 'logs'), { recursive: true })

  return { archiveDir, moved, unsynced }
}
