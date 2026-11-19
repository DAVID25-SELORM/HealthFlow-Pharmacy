import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { auth, autoMock } = vi.hoisted(() => ({
  auth: { role: 'admin' },
  autoMock: (overrides = {}) => async (importOriginal) => {
    const actual = await importOriginal()
    const mocked = {}
    for (const [key, value] of Object.entries(actual)) {
      mocked[key] = typeof value === 'function' ? vi.fn(async () => ({})) : value
    }
    return { ...mocked, ...overrides }
  },
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => true, supabase: {} }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
    role: auth.role,
    organization: { id: 'org1', can_use_nhis: true, can_use_multi_branch: true },
    refreshProfile: vi.fn(),
  }),
}))
vi.mock('../context/NotificationContext', () => ({ useNotification: () => ({ notify: vi.fn() }) }))
vi.mock('../context/TenantContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useTenant: () => ({
    isTrialActive: false,
    isSubscriptionActive: true,
    daysUntilTrialExpires: 0,
    tierLimits: { maxUsers: 20, maxBranches: 5 },
    canUseMultiBranch: true,
  }),
}))
vi.mock('../services/settingsService', autoMock({
  getPharmacySettings: vi.fn(async () => ({ id: 's1', pharmacy_name: 'Test Pharmacy' })),
  getUsers: vi.fn(async () => []),
}))
vi.mock('../services/branchService', autoMock({ getBranches: vi.fn(async () => []) }))
vi.mock('../services/branchServerApi', autoMock({
  getSavedBranchToken: vi.fn(() => ''),
  listBranchOfflineAccess: vi.fn(async () => []),
  listBranchOfflineAuthAudit: vi.fn(async () => []),
}))
vi.mock('../services/organizationService', autoMock({ getOrganizationStats: vi.fn(async () => ({})) }))
vi.mock('../services/nhisService', autoMock())
vi.mock('../services/backupService', autoMock({ listOnlineBackups: vi.fn(async () => []) }))
vi.mock('../services/paymentService', autoMock())

import Settings from './Settings'

const cardTitles = () => [...document.querySelectorAll('.settings-card')]
  .filter((card) => getComputedStyle(card).display !== 'none')
  .map((card) => card.className)

describe('Settings section menu', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  it('shows every section to an admin and switches the visible group', async () => {
    auth.role = 'admin'
    render(<Settings />)
    await screen.findByRole('navigation', { name: 'Settings sections' })

    const labels = [...document.querySelectorAll('.settings-nav-item')].map((b) => b.textContent)
    expect(labels).toEqual(['Facility', 'Branches & devices', 'Staff & access', 'Integrations', 'Data & backup', 'My account'])
    expect(document.querySelector('.settings-grid').getAttribute('data-group')).toBe('facility')

    fireEvent.click(screen.getByRole('button', { name: 'Integrations' }))
    expect(document.querySelector('.settings-grid').getAttribute('data-group')).toBe('integrations')
    expect(screen.getByRole('heading', { level: 2, name: 'Integrations' })).toBeTruthy()
  })

  it('tags every card with exactly one section', async () => {
    auth.role = 'admin'
    render(<Settings />)
    await screen.findByRole('navigation', { name: 'Settings sections' })
    const cards = [...document.querySelectorAll('.settings-grid > .settings-card')]
    expect(cards.length).toBeGreaterThanOrEqual(10)
    for (const card of cards) {
      expect((card.className.match(/\bsg-[a-z]+\b/g) || []).length).toBe(1)
    }
    expect(cardTitles().length).toBeGreaterThan(0)
  })

  it('only offers Facility and My account to non-admin staff', async () => {
    auth.role = 'pharmacist'
    render(<Settings />)
    await screen.findByRole('navigation', { name: 'Settings sections' })
    const labels = [...document.querySelectorAll('.settings-nav-item')].map((b) => b.textContent)
    expect(labels).toEqual(['Facility', 'My account'])
  })

  it('opens My account for the #offline-access link used elsewhere', async () => {
    auth.role = 'admin'
    window.location.hash = '#offline-access'
    render(<Settings />)
    await screen.findByRole('navigation', { name: 'Settings sections' })
    await waitFor(() => {
      expect(document.querySelector('.settings-grid').getAttribute('data-group')).toBe('account')
    })
    expect(document.getElementById('offline-access')).toBeTruthy()
  })
})
