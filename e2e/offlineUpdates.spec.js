import { test, expect } from '@playwright/test'
import { installFakeBackend } from './support/fakeBackend.js'
import { findOffScreenProblems } from './support/layoutChecks.js'

// The Updates tab and its notice, in the real built app, opened the way an offline server serves it:
// /branch-runtime-config.js says this is a branch server, and the update routes answer. All values are invented.
const SHOTS = process.env.UPDATE_SCREENSHOT_DIR || ''

const WAITING = {
  configured: true,
  state: 'available',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  releaseNotes: 'Example notes: what changed in this version appears here.',
  lastCheckedAt: '2030-01-02T12:00:00.000Z',
  lastCheckError: '',
  available: true,
  inProgress: false,
  installerSupported: true,
  installerReady: true,
}

const installFakeOfflineServer = async (page, role) => {
  let status = { ...WAITING }
  let polls = 0
  const calls = []

  await page.route('**/branch-runtime-config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.__HEALTHFLOW_BRANCH_SERVER__ = ${JSON.stringify({
      enabled: true, url: '', token: '', organizationId: 'org-guard-1', branchId: 'branch-guard-1',
    })};`,
  }))
  await page.route(/\/health$/, (route) => route.fulfill({ json: { ok: true, version: status.currentVersion, database: { integrity: 'ok' } } }))
  await page.route(/127\.0\.0\.1:\d+\/api\//, (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    calls.push(`${request.method()} ${path}`)

    if (path === '/api/auth/user-session') {
      return route.fulfill({ json: { data: { token: 'invented-session', role, userId: `user-guard-${role}`, expiresAt: 4102444800 } } })
    }
    if (path === '/api/updates/notice') {
      return route.fulfill({
        json: {
          data: {
            currentVersion: status.currentVersion,
            latestVersion: status.available ? status.latestVersion : '',
            releaseNotes: status.available ? status.releaseNotes : '',
            available: status.available,
            inProgress: status.inProgress,
          },
        },
      })
    }
    if (path.startsWith('/api/updates/') && role !== 'admin') {
      return route.fulfill({ status: 403, json: { error: 'Only an administrator can perform this action.' } })
    }
    if (path === '/api/updates/install') {
      status = { ...status, state: 'backing_up', inProgress: true, message: 'Backing up.' }
      return route.fulfill({ status: 202, json: { data: { ...status, restartRequired: true } } })
    }
    if (path === '/api/updates/status') {
      if (status.inProgress) {
        polls += 1
        if (polls > 2) status = { ...status, state: 'installed', inProgress: false, available: false, currentVersion: '1.1.0' }
      }
      return route.fulfill({ json: { data: status } })
    }
    return route.fulfill({ json: { data: [] } })
  })

  return { calls }
}

const shot = async (page, testInfo, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-${name}.png` })
}

test('an administrator is told about an update and installs it from the Updates tab', async ({ page }, testInfo) => {
  const crashes = []
  page.on('pageerror', (error) => crashes.push(error.message))
  await installFakeBackend(page, 'admin')
  const server = await installFakeOfflineServer(page, 'admin')

  await page.goto('/sales')
  const banner = page.locator('.branch-update-banner')
  await expect(banner).toContainText('A new HealthFlow version (1.1.0) is ready.')
  const width = page.viewportSize().width
  if (width > 1024) {
    await expect(page.locator('aside.sidebar').getByRole('link', { name: /Updates/ })).toContainText('New')
  }
  if (width <= 768) await expect(page.getByRole('img', { name: 'Update available' })).toBeVisible()
  expect(await findOffScreenProblems(page)).toEqual([])
  await shot(page, testInfo, '1-notice')

  await banner.getByRole('link', { name: 'Open Updates' }).click()
  await expect(page.getByRole('heading', { name: 'A new version is ready' })).toBeVisible()
  await expect(page.getByText(WAITING.releaseNotes)).toBeVisible()
  expect(await findOffScreenProblems(page)).toEqual([])
  await shot(page, testInfo, '2-updates-tab')

  await page.getByRole('button', { name: 'Update now' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Update HealthFlow now?' })
  await expect(dialog).toBeVisible()
  expect(server.calls).not.toContain('POST /api/updates/install')
  await shot(page, testInfo, '3-confirm')

  await dialog.getByRole('button', { name: /update healthflow now/i }).click()
  await expect(page.getByRole('heading', { name: 'HealthFlow is being updated' })).toBeVisible()
  await shot(page, testInfo, '4-updating')

  await expect(page.getByText('HealthFlow was updated to version 1.1.0.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload HealthFlow' })).toBeVisible()
  await shot(page, testInfo, '5-updated')
  expect(crashes, 'uncaught errors on the page').toEqual([])
})

test('other staff see the notice and are asked to tell the administrator', async ({ page }, testInfo) => {
  await installFakeBackend(page, 'cashier')
  const server = await installFakeOfflineServer(page, 'cashier')

  await page.goto('/updates')
  await expect(page.getByText('Ask your administrator to update HealthFlow.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Update now' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Check now' })).toHaveCount(0)
  expect(server.calls).not.toContain('GET /api/updates/status')
  expect(await findOffScreenProblems(page)).toEqual([])
  await shot(page, testInfo, '6-other-staff')
})

test('the online website has no Updates tab or update notice', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'computer', 'The menu rule is the same at every size.')
  await installFakeBackend(page, 'admin')

  await page.goto('/sales')
  await expect(page.locator('aside.sidebar')).toBeVisible()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('aside.sidebar').getByRole('link', { name: /^Updates/ })).toHaveCount(0)
  await expect(page.locator('.branch-update-banner')).toHaveCount(0)
})
