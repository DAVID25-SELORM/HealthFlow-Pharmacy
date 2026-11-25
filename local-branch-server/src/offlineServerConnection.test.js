// @vitest-environment node
// Starts the real server as its own process, with a temporary database and invented staff, and talks to it the way a
// browser does. Unit tests with hand-made requests missed that the app was never told it was on an offline server:
// the bundled placeholder file was served instead of the real answer.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SOURCE = path.resolve(process.cwd(), 'local-branch-server/src')
const SERVER_KEY = crypto.randomBytes(24).toString('base64url')
const ENROLLMENT_TOKEN = crypto.randomBytes(24).toString('base64url')
const PIN = '482915'

let directory
let server
let base
let computer
let env

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

const computerHeaders = (registered = computer) => ({
  'x-healthflow-workstation-id': registered.id,
  'x-healthflow-workstation-secret': registered.secret,
})

const call = async (route, { method = 'GET', headers = {}, body } = {}) => {
  const response = await fetch(base + route, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // The app page and the runtime config are not JSON.
  }
  return { status: response.status, headers: response.headers, text, json }
}

const signIn = async (role) => {
  const result = await call('/api/auth/offline-login', {
    method: 'POST',
    headers: computerHeaders(),
    body: { email: `${role}@example.test`, pin: PIN },
  })
  expect([role, result.status]).toEqual([role, 200])
  return { ...computerHeaders(), 'x-branch-user-session': result.json.data.token }
}

const signedSession = (key, role) => {
  const payload = Buffer.from(JSON.stringify({
    userId: `test-${role}`, role, assignedRoles: [role], offline: false,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url')
  return `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-real-server-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  env = {
    ...process.env,
    BRANCH_SERVER_TOKEN: SERVER_KEY,
    HEALTHFLOW_WORKSTATION_ENROLLMENT_TOKEN: ENROLLMENT_TOKEN,
    PORT: String(port),
    HOST: '127.0.0.1',
    HEALTHFLOW_DB_PATH: path.join(directory, 'data', 'branch.sqlite'),
    HEALTHFLOW_TLS_CERT_PATH: path.join(directory, 'none.crt'),
    HEALTHFLOW_TLS_KEY_PATH: path.join(directory, 'none.key'),
    HEALTHFLOW_TLS_PFX_PATH: '',
    HEALTHFLOW_UPDATE_MANIFEST_URL: '',
    SUPABASE_URL: '',
    SUPABASE_SYNC_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    ORGANIZATION_ID: '',
    BRANCH_ID: '',
  }
  server = spawn(process.execPath, [path.join(SOURCE, 'server.js')], { cwd: directory, env })
  let log = ''
  server.stdout.on('data', (chunk) => { log += chunk })
  server.stderr.on('data', (chunk) => { log += chunk })
  for (let attempt = 0; attempt < 120 && !log.includes('listening on'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!log.includes('listening on')) throw new Error(`The server did not start:\n${log}`)

  // Two invented staff with offline PINs, saved by the server's own code.
  const repository = (name) => JSON.stringify(pathToFileURL(path.join(SOURCE, name)).href)
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { db } = await import(${repository('db.js')})
    const { enrollOfflinePin } = await import(${repository('offlineAuthRepository.js')})
    for (const role of ['admin', 'cashier']) {
      db.prepare('INSERT INTO users (id, email, full_name, role, assigned_roles_json, is_active, offline_access_enabled) VALUES (?, ?, ?, ?, ?, 1, 1)')
        .run('test-' + role, role + '@example.test', 'Invented ' + role, role, JSON.stringify([role]))
      enrollOfflinePin({ userId: 'test-' + role, pin: '${PIN}' })
    }
  `], { cwd: directory, env })

  const enrolled = await call('/api/workstations/enroll', {
    method: 'POST',
    body: { enrollmentToken: ENROLLMENT_TOKEN, computerName: 'TEST-COMPUTER' },
  })
  expect(enrolled.status).toBe(201)
  computer = enrolled.json.data
}, 90000)

afterAll(async () => {
  if (server) {
    const exited = new Promise((resolve) => server.once('exit', resolve))
    server.kill()
    await exited
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

describe('what the real server tells the app', () => {
  it('says it is an offline server, although the bundle holds an empty file of the same name', async () => {
    const placeholder = fs.readFileSync(path.join(SOURCE, '..', 'public', 'branch-runtime-config.js'), 'utf8')
    expect(placeholder).not.toContain('"enabled":true')

    const result = await call('/branch-runtime-config.js')
    expect(result.status).toBe(200)
    expect(result.text).toContain('window.__HEALTHFLOW_BRANCH_SERVER__ = {"enabled":true')
    expect(result.headers.get('cache-control')).toBe('no-store')
  })

  it('never hands out its key, whatever a request claims about itself', async () => {
    for (const headers of [{}, { 'Sec-Fetch-Site': 'same-origin' }, computerHeaders()]) {
      const result = await call('/branch-runtime-config.js', { headers })
      expect(result.headers.get('set-cookie')).toBeNull()
      expect(result.text).not.toContain(SERVER_KEY)
      expect(result.text).toContain('"token":""')
    }
  })
})

describe('who may talk to the real server', () => {
  it('refuses a computer that is not registered', async () => {
    const wrong = { id: computer.id, secret: 'not-the-secret' }
    for (const headers of [{}, computerHeaders(wrong), { 'x-healthflow-workstation-id': computer.id }]) {
      expect((await call('/health', { headers })).status).toBe(401)
      const login = await call('/api/auth/offline-login', {
        method: 'POST', headers, body: { email: 'cashier@example.test', pin: PIN },
      })
      expect(login.status).toBe(401)
      expect(login.json.error).toMatch(/desktop shortcut/)
    }
  })

  it('lets a registered computer sign staff in and keeps each to their role, without the server key', async () => {
    expect((await call('/health', { headers: computerHeaders() })).json.ok).toBe(true)

    const cashier = await signIn('cashier')
    expect((await call('/api/pos/bootstrap', { headers: cashier })).status).toBe(200)
    expect((await call('/api/updates/notice', { headers: cashier })).status).toBe(200)
    expect((await call('/api/database/backup', { method: 'POST', headers: cashier, body: {} })).status).toBe(403)

    const admin = await signIn('admin')
    expect((await call('/api/updates/status', { headers: admin })).status).toBe(200)
  })

  it('still accepts the server key from its own scripts', async () => {
    expect((await call('/health', { headers: { 'x-branch-token': SERVER_KEY } })).status).toBe(200)
  })

  it('needs a registered computer as well as the server key once any computer is registered', async () => {
    const result = await call('/api/updates/notice', { headers: { 'x-branch-token': SERVER_KEY } })
    expect(result.status).toBe(401)
  })
})

describe('staff sessions', () => {
  it('cannot be made by someone who holds the server key', async () => {
    const forged = { ...computerHeaders(), 'x-branch-user-session': signedSession(SERVER_KEY, 'admin') }
    const result = await call('/api/updates/status', { headers: forged })
    expect(result.status).toBe(401)
  })

  it('are signed with a secret kept in its own file, which database backups do not copy', async () => {
    const secretFile = path.join(directory, 'data', 'session-signing.key')
    const secret = fs.readFileSync(secretFile, 'utf8')
    expect(secret.length).toBeGreaterThanOrEqual(43)
    expect(secret).not.toBe(SERVER_KEY)
    // The right secret does work, so the refusal above is about the key used and not the shape of the test.
    const genuine = { ...computerHeaders(), 'x-branch-user-session': signedSession(secret, 'admin') }
    expect((await call('/api/updates/status', { headers: genuine })).status).toBe(200)

    const admin = await signIn('admin')
    const backup = await call('/api/database/backup', { method: 'POST', headers: admin, body: {} })
    expect(backup.status).toBe(201)
    const backups = path.join(directory, 'data', 'backups')
    for (const name of fs.readdirSync(backups)) {
      expect(name).not.toContain('session-signing')
      expect(fs.readFileSync(path.join(backups, name)).includes(Buffer.from(secret))).toBe(false)
    }
    expect((await call('/session-signing.key', { headers: computerHeaders() })).text).not.toContain(secret)
  })
})

describe('a computer that is revoked', () => {
  it('is shut out at once', async () => {
    const admin = await signIn('admin')
    const revoked = await call(`/api/deployment/workstations/${computer.id}`, { method: 'DELETE', headers: admin })
    expect(revoked.status).toBe(200)

    expect((await call('/health', { headers: computerHeaders() })).status).toBe(401)
    expect((await call('/api/updates/notice', { headers: admin })).status).toBe(401)
  })
})
