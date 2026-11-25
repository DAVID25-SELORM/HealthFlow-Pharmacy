import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  UPDATE_RETRY_INTERVAL_MS,
  buildCheckFailure,
  buildCheckSuccess,
  describeUpdateError,
  getUpdateNotice,
  isCheckDue,
  isUpdateInProgress,
  parseStatusText,
} from './updateManager'
import { authorizeLocalOperationalRoute } from './localAuthorization'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2030-01-02T12:00:00.000Z')
const ago = (milliseconds) => new Date(NOW - milliseconds).toISOString()
const manifest = { version: '2.0.0', releaseNotes: 'Invented notes', publishedAt: ago(HOUR) }

describe('the status file the Windows updater writes', () => {
  it('can be read although it starts with a byte-order mark', () => {
    expect(parseStatusText('﻿{\r\n  "state": "rolled_back"\r\n}\r\n')).toEqual({ state: 'rolled_back' })
    expect(parseStatusText('{"state":"installed"}')).toEqual({ state: 'installed' })
  })

  it.runIf(process.platform === 'win32')('can be read exactly as Windows PowerShell saves it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-status-'))
    const file = path.join(directory, 'status.json')
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `@{ state='installed'; latestVersion='2.0.0'; updatedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath '${file}' -Encoding UTF8`,
      ])
      const status = parseStatusText(fs.readFileSync(file, 'utf8'))
      expect(status.state).toBe('installed')
      expect(Number.isFinite(Date.parse(status.updatedAt))).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 30000)
})

describe('when the server checks for an update', () => {
  it('checks again after a short wait when the last check did not work', () => {
    expect(UPDATE_RETRY_INTERVAL_MS).toBe(15 * 60 * 1000)
    expect(isCheckDue({ lastCheckedAt: ago(HOUR), lastCheckError: 'offline' }, NOW, 24)).toBe(true)
  })

  it('otherwise waits the configured number of hours', () => {
    expect(isCheckDue({ lastCheckedAt: ago(23 * HOUR), lastCheckError: '' }, NOW, 24)).toBe(false)
    expect(isCheckDue({ lastCheckedAt: ago(24 * HOUR), lastCheckError: '' }, NOW, 24)).toBe(true)
    expect(isCheckDue({}, NOW, 24)).toBe(true)
  })

  it('never checks while an install is running, or when checks are switched off', () => {
    expect(isCheckDue({ state: 'verifying', updatedAt: ago(1000) }, NOW, 24)).toBe(false)
    expect(isCheckDue({ lastCheckError: 'offline' }, NOW, 0)).toBe(false)
  })

  it('does not let an install that stopped reporting block updates for ever', () => {
    expect(isUpdateInProgress({ state: 'installing', updatedAt: ago(29 * 60 * 1000) }, NOW)).toBe(true)
    expect(isUpdateInProgress({ state: 'installing', updatedAt: ago(31 * 60 * 1000) }, NOW)).toBe(false)
    expect(isUpdateInProgress({ state: 'installed', updatedAt: ago(1000) }, NOW)).toBe(false)
  })
})

describe('what a check remembers', () => {
  it('keeps an update it already found when the internet drops', () => {
    const found = buildCheckSuccess({}, manifest, '1.0.0', new Date(NOW))
    const after = buildCheckFailure(found, new TypeError('fetch failed'), '1.0.0')

    expect(after.state).toBe('available')
    expect(after.latestVersion).toBe('2.0.0')
    expect(after.releaseNotes).toBe('Invented notes')
    expect(after.lastCheckedAt).toBe(found.lastCheckedAt)
    expect(after.lastCheckError).toMatch(/check the internet connection/i)
    expect(buildCheckSuccess(after, manifest, '1.0.0').lastCheckError).toBe('')
  })

  it('keeps the record that the previous version was restored', () => {
    const restored = { state: 'rolled_back', latestVersion: '2.0.0', message: 'Invented failure', updatedAt: ago(HOUR) }
    const expected = { state: 'rolled_back', version: '2.0.0', message: 'Invented failure', at: ago(HOUR) }
    const next = buildCheckSuccess(restored, manifest, '1.0.0')

    expect(next.state).toBe('available')
    expect(next.lastInstall).toEqual(expected)
    expect(buildCheckSuccess(next, manifest, '1.0.0').lastInstall).toEqual(expected)
    expect(buildCheckFailure(restored, new TypeError('fetch failed'), '1.0.0').lastInstall).toEqual(expected)
  })

  it('says plainly when nothing is known yet, and keeps other errors as they are', () => {
    expect(buildCheckFailure({}, new TypeError('fetch failed'), '1.0.0').state).toBe('check_failed')
    expect(describeUpdateError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
      .toMatch(/check the internet connection/i)
    expect(describeUpdateError(new Error('The update manifest signature is invalid.')))
      .toBe('The update manifest signature is invalid.')
  })
})

describe('what ordinary staff are told', () => {
  it('is only whether an update is waiting, with no server details', () => {
    const status = {
      currentVersion: '1.0.0', latestVersion: '2.0.0', releaseNotes: 'Invented notes', available: true,
      inProgress: false, platform: 'win32', channel: 'beta', message: 'internal', lastCheckError: 'internal',
    }
    expect(getUpdateNotice(status)).toEqual({
      currentVersion: '1.0.0', latestVersion: '2.0.0', releaseNotes: 'Invented notes', available: true, inProgress: false,
    })
    expect(getUpdateNotice({ ...status, available: false })).toMatchObject({ latestVersion: '', releaseNotes: '' })
  })
})

describe('who may use the update routes', () => {
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'local-branch-server/src/server.js'), 'utf8')

  it('guards checking, installing and full status with the administrator check on the route itself', () => {
    const routes = [...serverSource.matchAll(/app\.(get|post)\('(\/api\/updates\/[a-z]+)',\s*([A-Za-z]+)?/g)]
      .map((match) => ({ route: match[2], guard: match[3] === 'requireBranchAdminAccess' }))

    expect(routes).toEqual([
      { route: '/api/updates/notice', guard: false },
      { route: '/api/updates/status', guard: true },
      { route: '/api/updates/check', guard: true },
      { route: '/api/updates/install', guard: true },
    ])
    // Registered after the signed-in staff requirement, so the notice is not open to people who are not signed in.
    expect(serverSource.indexOf("app.use('/api', requireBranchUserSession"))
      .toBeLessThan(serverSource.indexOf("app.get('/api/updates/notice'"))
  })

  it('lets any signed-in role read the notice', () => {
    let passed = false
    authorizeLocalOperationalRoute(
      { method: 'GET', path: '/api/updates/notice', branchUser: { role: 'cashier' } },
      { status: () => ({ json: () => {} }) },
      () => { passed = true }
    )
    expect(passed).toBe(true)
  })
})
