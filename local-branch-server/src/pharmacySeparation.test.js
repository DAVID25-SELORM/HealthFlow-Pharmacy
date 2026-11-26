// @vitest-environment node
// One offline computer, two invented pharmacies. The real server runs as its own process against one database, the
// way a computer does when it is connected to a second pharmacy.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { DATA_OWNER_KEY, evaluateDataOwner, getDataOwners } from './dataOwner.js'
import { assertComputerCanConnect } from './connectGuard.js'
import { archiveFacilityData, clearFacilitySettings, countUnsyncedRecords } from './archiveFacilityData.js'

const SOURCE = path.resolve(process.cwd(), 'local-branch-server/src')
const SCHEMA = fs.readFileSync(path.join(SOURCE, 'schema.sql'), 'utf8')
const A = { organization: '11111111-1111-4111-8111-111111111111', branch: '22222222-2222-4222-8222-222222222222' }
const B = { organization: '33333333-3333-4333-8333-333333333333', branch: '44444444-4444-4444-8444-444444444444' }
const PATIENT = 'Invented Patient Of Pharmacy A'
const PIN = '482915'
const SERVER_KEY = crypto.randomBytes(24).toString('base64url')
const ENROLLMENT_TOKEN = crypto.randomBytes(24).toString('base64url')

const temporary = []
const makeDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-separation-'))
  temporary.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const emptyDatabase = () => {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}
const addRecord = (db, organization) =>
  db.prepare("INSERT INTO offline_records (id, entity_type, data_json) VALUES (?, 'patients', ?)")
    .run(crypto.randomUUID(), JSON.stringify(organization ? { organization_id: organization } : { full_name: 'Unmarked' }))

describe('whose records a database holds', () => {
  it('is marked for the first pharmacy connected to an empty database, and locks for any other', () => {
    const db = emptyDatabase()
    expect(evaluateDataOwner(db, '')).toEqual({ locked: false })
    expect(getDataOwners(db)).toEqual([])
    expect(evaluateDataOwner(db, A.organization)).toEqual({ locked: false })
    expect(db.prepare('SELECT value FROM branch_meta WHERE key = ?').get(DATA_OWNER_KEY).value).toBe(A.organization)
    expect(evaluateDataOwner(db, B.organization)).toEqual({ locked: true })
    expect(evaluateDataOwner(db, '')).toEqual({ locked: true })
    expect(evaluateDataOwner(db, A.organization.toUpperCase())).toEqual({ locked: false })
  })

  it('is worked out from the records of a computer set up before the mark existed', () => {
    const db = emptyDatabase()
    addRecord(db, A.organization)
    expect(evaluateDataOwner(db, B.organization)).toEqual({ locked: true })
    expect(getDataOwners(db)).toEqual([A.organization])
    expect(evaluateDataOwner(db, A.organization)).toEqual({ locked: false })
  })

  it('stays locked when the records of two pharmacies are already mixed', () => {
    const db = emptyDatabase()
    addRecord(db, A.organization)
    addRecord(db, B.organization)
    expect(evaluateDataOwner(db, A.organization)).toEqual({ locked: true })
    expect(evaluateDataOwner(db, B.organization)).toEqual({ locked: true })
  })

  it('does not count a staff entry, which an outsider could have left by trying to sign in', () => {
    const db = emptyDatabase()
    addRecord(db, A.organization)
    db.prepare('INSERT INTO users (id, organization_id) VALUES (?, ?)').run('outsider', B.organization)
    expect(evaluateDataOwner(db, A.organization)).toEqual({ locked: false })
  })

  it('treats records that name no pharmacy as belonging to the one connected until now', () => {
    const directory = makeDirectory()
    const databasePath = path.join(directory, 'records.sqlite')
    const file = new Database(databasePath)
    file.exec(SCHEMA)
    addRecord(file, '')
    file.close()
    const envPath = path.join(directory, '.env')
    fs.writeFileSync(envPath, `ORGANIZATION_ID=${A.organization}\n`)
    const connect = (organizationId) => assertComputerCanConnect({ databasePaths: [databasePath], envPath, organizationId })

    expect(() => connect(B.organization)).toThrow(/another pharmacy/i)
    expect(() => connect(A.organization)).not.toThrow()
  })

  it('is never assumed to be nobody when the database cannot be read', () => {
    const databasePath = path.join(makeDirectory(), 'broken.sqlite')
    fs.writeFileSync(databasePath, 'this is not a database'.repeat(200))
    expect(() => assertComputerCanConnect({ databasePaths: [databasePath], envPath: '', organizationId: B.organization }))
      .toThrow(/could not be checked/i)
  })
})

describe('a real offline computer that is connected to a second pharmacy', () => {
  let installRoot
  let databasePath
  let computer

  const freePort = () => new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

  const environment = (pharmacy, port) => ({
    ...process.env,
    BRANCH_SERVER_TOKEN: SERVER_KEY,
    HEALTHFLOW_WORKSTATION_ENROLLMENT_TOKEN: ENROLLMENT_TOKEN,
    PORT: String(port),
    HOST: '127.0.0.1',
    HEALTHFLOW_DB_PATH: databasePath,
    HEALTHFLOW_TLS_CERT_PATH: path.join(installRoot, 'none.crt'),
    HEALTHFLOW_TLS_KEY_PATH: path.join(installRoot, 'none.key'),
    HEALTHFLOW_TLS_PFX_PATH: '',
    HEALTHFLOW_UPDATE_MANIFEST_URL: '',
    SUPABASE_URL: '',
    SUPABASE_SYNC_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    ORGANIZATION_ID: pharmacy.organization,
    BRANCH_ID: pharmacy.branch,
  })

  const addStaff = (pharmacy, id) => {
    const repository = (name) => JSON.stringify(pathToFileURL(path.join(SOURCE, name)).href)
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { db } = await import(${repository('db.js')})
      const { enrollOfflinePin } = await import(${repository('offlineAuthRepository.js')})
      db.prepare('INSERT INTO users (id, email, full_name, role, assigned_roles_json, organization_id, branch_id, is_active, offline_access_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)')
        .run('${id}', '${id}@example.test', 'Invented ${id}', 'admin', '["admin"]', '${pharmacy.organization}', '${pharmacy.branch}')
      enrollOfflinePin({ userId: '${id}', pin: '${PIN}' })
    `], { cwd: installRoot, env: environment(pharmacy, 0) })
  }

  const withServer = async (pharmacy, work) => {
    const port = await freePort()
    const child = spawn(process.execPath, [path.join(SOURCE, 'server.js')], { cwd: installRoot, env: environment(pharmacy, port) })
    let log = ''
    child.stdout.on('data', (chunk) => { log += chunk })
    child.stderr.on('data', (chunk) => { log += chunk })
    try {
      for (let attempt = 0; attempt < 120 && !log.includes('listening on'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!log.includes('listening on')) throw new Error(`The server did not start:\n${log}`)
      const call = async (route, { method = 'GET', headers = {}, body } = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        const text = await response.text()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          // The runtime config is not JSON.
        }
        return { status: response.status, text, json }
      }
      const device = () => ({
        'x-healthflow-workstation-id': computer.id,
        'x-healthflow-workstation-secret': computer.secret,
      })
      const signIn = async (id) => {
        const result = await call('/api/auth/offline-login', {
          method: 'POST', headers: device(), body: { email: `${id}@example.test`, pin: PIN },
        })
        const token = result.json?.data?.token
        return { ...result, headers: token ? { ...device(), 'x-branch-user-session': token } : null }
      }
      await work({ call, device, signIn, log: () => log })
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await exited
    }
  }

  beforeAll(async () => {
    installRoot = makeDirectory()
    fs.mkdirSync(path.join(installRoot, 'data'))
    databasePath = path.join(installRoot, 'data', 'healthflow-branch.sqlite')
    await withServer(A, async ({ call }) => {
      const enrolled = await call('/api/workstations/enroll', {
        method: 'POST', body: { enrollmentToken: ENROLLMENT_TOKEN, computerName: 'SHARED-COMPUTER' },
      })
      computer = enrolled.json.data
    })
    addStaff(A, 'staff-a')
    addStaff(B, 'staff-b')
    await withServer(A, async ({ call, signIn }) => {
      const staff = await signIn('staff-a')
      const saved = await call('/api/patients', {
        method: 'POST', headers: staff.headers, body: { full_name: PATIENT, phone: '0000000000', organization_id: A.organization },
      })
      expect(saved.status).toBe(201)
    })
  }, 120000)

  it('locks: nobody can read the first pharmacy, and the app is told why', async () => {
    await withServer(B, async ({ call, device, signIn, log }) => {
      for (const id of ['staff-b', 'staff-a']) {
        const result = await signIn(id)
        expect([id, result.status, result.json.code]).toEqual([id, 423, 'DATA_BELONGS_TO_ANOTHER_PHARMACY'])
      }
      const attempts = [
        ['GET', '/api/patients'], ['GET', '/api/preload'], ['GET', '/api/database/backups/any.sqlite/download'],
        ['POST', '/api/database/backup'], ['POST', '/api/sync/run'], ['POST', '/api/workstations/enroll'],
        ['POST', '/api/payments/webhook/paystack'], ['GET', '/API/Patients'],
      ]
      for (const [method, route] of attempts) {
        const result = await call(route, { method, headers: { ...device(), 'x-branch-token': SERVER_KEY }, ...(method === 'POST' ? { body: {} } : {}) })
        expect([route, result.status]).toEqual([route, 423])
        expect(result.text).not.toContain(PATIENT)
      }
      const health = await call('/health', { headers: device() })
      expect(health.json).toMatchObject({ dataLocked: true })
      expect(health.json.nhia).toBeUndefined()
      const config = await call('/branch-runtime-config.js')
      expect(config.text).toContain('"dataLocked":true')
      expect(config.text).not.toContain(A.organization)
      expect(log()).toContain('LOCKED:')
      expect(log()).not.toContain('branch sync worker running')
    })
  }, 60000)

  it('is unharmed, and opens again for the pharmacy it belongs to', async () => {
    await withServer(A, async ({ call, signIn }) => {
      const staff = await signIn('staff-a')
      expect(staff.status).toBe(200)
      const patients = await call('/api/patients', { headers: staff.headers })
      expect(patients.text).toContain(PATIENT)
      expect((await call('/branch-runtime-config.js')).text).toContain('"dataLocked":false')
      // Someone from another pharmacy is still refused here.
      expect((await signIn('staff-b')).headers).toBeNull()
    })
  }, 60000)

  it('cannot be connected to the second pharmacy by the setup script, which changes nothing', () => {
    const envPath = path.join(installRoot, 'connect.env')
    const before = `ORGANIZATION_ID=${A.organization}\nBRANCH_ID=${A.branch}\n`
    fs.writeFileSync(envPath, before)
    const block = (pharmacy) => [
      `ORGANIZATION_ID=${pharmacy.organization}`,
      `BRANCH_ID=${pharmacy.branch}`,
      `BRANCH_SYNC_TOKEN=${'t'.repeat(48)}`,
      'SUPABASE_URL=https://invented-project.supabase.co',
      `SUPABASE_SYNC_KEY=${'k'.repeat(40)}`,
      `NHIA_CONFIG_SECRET_KEY=${'n'.repeat(40)}`,
    ].join('\n')
    const connect = (pharmacy) => spawnSync(process.execPath, [path.resolve(SOURCE, '..', 'scripts', 'connect-to-cloud.mjs')], {
      cwd: installRoot,
      input: block(pharmacy),
      encoding: 'utf8',
      env: { ...process.env, HEALTHFLOW_ENV_PATH: envPath, HEALTHFLOW_DB_PATH: databasePath, ORGANIZATION_ID: '' },
    })

    const refused = connect(B)
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('another pharmacy')
    expect(refused.stderr).toContain('Nothing was changed.')
    expect(fs.readFileSync(envPath, 'utf8')).toBe(before)
    expect(connect(A).status).toBe(0)
  }, 60000)

  it('starts clean for the second pharmacy only after the first one has been archived', async () => {
    const serverFolder = path.join(installRoot, 'local-branch-server')
    fs.mkdirSync(serverFolder, { recursive: true })
    const envPath = path.join(serverFolder, '.env')
    fs.writeFileSync(envPath, `ORGANIZATION_ID=${A.organization}\r\nBRANCH_SYNC_TOKEN=secret-of-a\r\nPORT=4780\r\n`)

    // The patient has not reached the cloud, so nothing may move without saying so.
    expect(countUnsyncedRecords(databasePath)).toBeGreaterThan(0)
    expect(() => archiveFacilityData({ installRoot })).toThrow(/have not reached HealthFlow Cloud/)
    expect(fs.existsSync(databasePath)).toBe(true)
    expect(fs.readFileSync(envPath, 'utf8')).toContain('secret-of-a')

    const result = archiveFacilityData({ installRoot, allowUnsynced: true, now: new Date('2030-01-02T03:04:05Z') })
    expect(fs.existsSync(databasePath)).toBe(false)
    expect(fs.existsSync(path.join(installRoot, 'data', 'session-signing.key'))).toBe(false)
    expect(fs.readFileSync(envPath, 'utf8')).toBe('ORGANIZATION_ID=\r\nBRANCH_SYNC_TOKEN=\r\nPORT=4780\r\n')
    expect(fs.readFileSync(path.join(result.archiveDir, 'env.settings'), 'utf8')).toContain('secret-of-a')

    // Nothing was lost: the archived database still holds the first pharmacy's patient.
    const archived = new Database(path.join(result.archiveDir, 'healthflow-branch.sqlite'), { readonly: true })
    expect(JSON.stringify(archived.prepare('SELECT * FROM offline_records').all())).toContain(PATIENT)
    archived.close()

    computer = null
    await withServer(B, async ({ call }) => {
      const enrolled = await call('/api/workstations/enroll', {
        method: 'POST', body: { enrollmentToken: ENROLLMENT_TOKEN, computerName: 'SHARED-COMPUTER' },
      })
      computer = enrolled.json.data
    })
    addStaff(B, 'staff-b2')
    await withServer(B, async ({ call, signIn }) => {
      const staff = await signIn('staff-b2')
      expect(staff.status).toBe(200)
      const patients = await call('/api/patients', { headers: staff.headers })
      expect(patients.status).toBe(200)
      expect(patients.text).not.toContain(PATIENT)
      expect((await signIn('staff-a')).headers).toBeNull()
    })
  }, 120000)
})

describe('clearing settings for a new pharmacy', () => {
  it("removes what belongs to one pharmacy and keeps the product's own settings", () => {
    const kept = [
      'SUPABASE_URL=https://invented.supabase.co', 'SUPABASE_SYNC_KEY=public', 'NHIA_BASE_URL=https://nhia.example',
      'NHIA_ELIGIBILITY_BASE_URL=https://nhia.example', 'HEALTHFLOW_UPDATE_PUBLIC_KEY=public', 'PORT=4780', '# FACILITY_NAME=comment',
    ]
    const cleared = [
      'ORGANIZATION_ID', 'BRANCH_ID', 'BRANCH_SYNC_TOKEN', 'BRANCH_SERVER_TOKEN', 'NHIA_CONFIG_SECRET_KEY',
      'NHIA_FACILITY_CODE', 'NHIA_CREDENTIAL_CODE', 'FACILITY_NAME', 'FACILITY_PHONE', 'CLAIMIT_UPSTREAM_API_SECRET',
      'PAYSTACK_SECRET_KEY', 'SMS_HUBTEL_CLIENT_SECRET',
    ]
    const result = clearFacilitySettings([...kept, ...cleared.map((name) => `${name}=value-of-old-pharmacy`)].join('\n'))
    expect(result.split('\n')).toEqual([...kept, ...cleared.map((name) => `${name}=`)])
  })
})
