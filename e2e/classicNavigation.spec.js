import { test, expect } from '@playwright/test'
import { installFakeBackend } from './support/fakeBackend.js'
import { findHiddenBehindBottomBar, findOffScreenProblems, findPanelProblems } from './support/layoutChecks.js'

// The platform administrator can switch the new navigation off for one pharmacy
// ("classic menu"). Those pharmacies must still get a working, on-screen menu.

const isPhone = (viewport) => viewport.width <= 768

test.describe('classic navigation switched on', () => {
  test('phones get the menu button and a plain side menu instead of the bottom bar', async ({ page }) => {
    const viewport = page.viewportSize()
    test.skip(!isPhone(viewport), 'Only phones differ from the tablet and computer layouts here.')

    await installFakeBackend(page, 'admin', { interfaceFlags: { classic_navigation: true } })
    await page.goto('/dashboard')
    await expect(page.locator('.topbar')).toBeVisible()

    await expect(page.locator('.bottom-nav')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible()

    await page.getByRole('button', { name: 'Open navigation menu' }).click()
    await expect(page.locator('aside.sidebar.open')).toBeVisible()
    await expect.poll(() => findPanelProblems(page, 'aside.sidebar.open', 'The side menu')).toEqual([])
    await expect(page.locator('aside.sidebar .nav-group-toggle')).toHaveCount(0)
    await expect(page.locator('aside.sidebar').getByRole('link', { name: /Inventory/ })).toBeVisible()
    await expect(page.locator('aside.sidebar').getByRole('link', { name: /Reports/ })).toBeVisible()
  })

  test('every key screen stays on screen without the bottom bar', async ({ page }) => {
    await installFakeBackend(page, 'admin', { interfaceFlags: { classic_navigation: true } })
    for (const path of ['/dashboard', '/sales', '/nhis', '/inventory']) {
      await page.goto(path)
      await expect(page.locator('.page-content')).toBeVisible()
      await page.waitForLoadState('networkidle')
      expect(await findOffScreenProblems(page), `${path} on a ${page.viewportSize().width}px screen`).toEqual([])
      expect(await findHiddenBehindBottomBar(page)).toEqual([])
    }
  })

  test('computers keep the full side menu without the slim-rail button', async ({ page }) => {
    const viewport = page.viewportSize()
    test.skip(viewport.width <= 1024, 'The side menu is always visible on computers only.')

    await installFakeBackend(page, 'admin', { interfaceFlags: { classic_navigation: true } })
    await page.goto('/dashboard')
    await expect(page.locator('aside.sidebar')).toBeVisible()
    await expect(page.getByRole('button', { name: /Collapse sidebar/ })).toHaveCount(0)
    await expect(page.locator('.bottom-nav')).toHaveCount(0)
  })
})

test.describe('classic navigation switched off (the default)', () => {
  test('phones keep the bottom bar', async ({ page }) => {
    test.skip(!isPhone(page.viewportSize()), 'The bottom bar only exists on phones.')

    await installFakeBackend(page, 'admin', { interfaceFlags: { classic_navigation: false } })
    await page.goto('/dashboard')
    await expect(page.locator('.bottom-nav')).toBeVisible()
  })
})
