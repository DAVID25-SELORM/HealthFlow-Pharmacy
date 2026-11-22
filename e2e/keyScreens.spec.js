import { test, expect } from '@playwright/test'
import { installFakeBackend } from './support/fakeBackend.js'
import { findHiddenBehindBottomBar, findOffScreenProblems, findPanelProblems } from './support/layoutChecks.js'

// The screens pharmacies use all day. If a change makes any of these run off the
// screen, lose its menu, or crash, this suite fails before the change can merge.
const SCREENS = [
  { path: '/dashboard', name: 'Dashboard' },
  { path: '/sales', name: 'Sales' },
  { path: '/inventory', name: 'Inventory' },
  { path: '/purchases', name: 'Purchases' },
  { path: '/nhis', name: 'NHIS' },
  { path: '/claims', name: 'Claims' },
  { path: '/patients', name: 'Patients' },
  { path: '/settings', name: 'Settings' },
]

const ROLES = ['admin', 'cashier']

const isPhone = (viewport) => viewport.width <= 768

for (const role of ROLES) {
  test.describe(`signed in as ${role}`, () => {
    for (const screen of SCREENS) {
      test(`${screen.name} stays on screen and keeps its menus`, async ({ page }) => {
        const crashes = []
        page.on('pageerror', (error) => crashes.push(error.message))

        await installFakeBackend(page, role)
        await page.goto(screen.path)

        // Signed in, not bounced to the login page, and the workspace actually loaded.
        await expect(page.locator('.topbar')).toBeVisible()
        await expect(page.locator('.page-content')).toBeVisible()
        await expect(page.getByText('Unable to load workspace')).toHaveCount(0)
        await expect(page.getByText(/something went wrong/i)).toHaveCount(0)
        await page.waitForLoadState('networkidle')

        const viewport = page.viewportSize()

        // The right menu for the screen size.
        if (isPhone(viewport)) {
          await expect(page.locator('.bottom-nav')).toBeVisible()
        } else {
          await expect(page.locator('.bottom-nav')).toBeHidden()
        }
        if (viewport.width > 1024) {
          await expect(page.locator('aside.sidebar')).toBeVisible()
        }

        const problems = [
          ...(await findOffScreenProblems(page)),
          ...(isPhone(viewport) ? await findHiddenBehindBottomBar(page) : []),
        ]
        expect(problems, `${screen.name} as ${role} on a ${viewport.width}px screen`).toEqual([])
        expect(crashes, 'uncaught errors on the page').toEqual([])
      })
    }
  })
}

test.describe('floating panels', () => {
  test('the notifications panel opens fully on screen', async ({ page }) => {
    await installFakeBackend(page, 'admin')
    await page.goto('/dashboard')
    await expect(page.locator('.topbar')).toBeVisible()

    await page.getByRole('button', { name: 'View notifications' }).click()
    await expect(page.locator('.alerts-panel')).toBeVisible()

    expect(await findPanelProblems(page, '.alerts-panel', 'The notifications panel')).toEqual([])
  })

  test('the More menu opens fully on screen and lists the other screens', async ({ page }) => {
    const viewport = page.viewportSize()
    test.skip(!isPhone(viewport), 'The bottom bar and More menu only exist on phones.')

    await installFakeBackend(page, 'admin')
    await page.goto('/dashboard')
    await expect(page.locator('.bottom-nav')).toBeVisible()

    await page.locator('.bottom-nav').getByRole('button', { name: 'More' }).click()
    await expect(page.getByRole('dialog', { name: 'More' })).toBeVisible()
    expect(await findPanelProblems(page, '.bottom-sheet', 'The More menu')).toEqual([])
    await expect(page.locator('.bottom-sheet-tile').first()).toBeVisible()
  })

  test('the side menu opens on a tablet', async ({ page }) => {
    const viewport = page.viewportSize()
    test.skip(viewport.width <= 768 || viewport.width > 1024, 'Only tablets use the slide-in side menu.')

    await installFakeBackend(page, 'admin')
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Open navigation menu' }).click()
    await expect(page.locator('aside.sidebar.open')).toBeVisible()
    // The menu slides in, so wait for it to settle before measuring.
    await expect.poll(() => findPanelProblems(page, 'aside.sidebar.open', 'The side menu')).toEqual([])
  })
})
