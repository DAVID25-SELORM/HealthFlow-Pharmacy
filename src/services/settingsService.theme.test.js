import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getCurrentSupabaseUser, from } = vi.hoisted(() => ({
  getCurrentSupabaseUser: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  getCurrentSupabaseUser,
  invokeSupabaseFunction: vi.fn(),
  supabase: {
    from,
  },
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

import { getPharmacyThemeSettings } from './settingsService'

const makeSettingsQuery = ({ data = null, error = null } = {}) => {
  const query = {
    select: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error })),
    insert: vi.fn(),
  }
  return query
}

describe('settingsService theme settings', () => {
  beforeEach(() => {
    getCurrentSupabaseUser.mockReset()
    from.mockReset()
  })

  it('loads facility theme settings without creating a pharmacy_settings row', async () => {
    getCurrentSupabaseUser.mockResolvedValue({ id: 'user-1' })
    const userQuery = {
      select: vi.fn(() => userQuery),
      eq: vi.fn(() => userQuery),
      maybeSingle: vi.fn(async () => ({
        data: { organization_id: 'org-1' },
        error: null,
      })),
    }
    const settingsQuery = makeSettingsQuery({
      data: {
        theme_primary_color: '#16a085',
        theme_secondary_color: '#0f766e',
        theme_accent_color: '#f59e0b',
      },
    })
    from.mockImplementation((table) => {
      if (table === 'users') return userQuery
      if (table === 'pharmacy_settings') return settingsQuery
      throw new Error(`Unexpected table ${table}`)
    })

    const settings = await getPharmacyThemeSettings()

    expect(settings).toEqual({
      theme_primary_color: '#16a085',
      theme_secondary_color: '#0f766e',
      theme_accent_color: '#f59e0b',
    })
    expect(settingsQuery.select).toHaveBeenCalledWith(
      'theme_primary_color,theme_secondary_color,theme_accent_color'
    )
    expect(settingsQuery.eq).toHaveBeenCalledWith('organization_id', 'org-1')
    expect(settingsQuery.insert).not.toHaveBeenCalled()
  })

  it('returns null without inserting when no theme row exists', async () => {
    getCurrentSupabaseUser.mockResolvedValue({ id: 'user-1' })
    const userQuery = {
      select: vi.fn(() => userQuery),
      eq: vi.fn(() => userQuery),
      maybeSingle: vi.fn(async () => ({
        data: { organization_id: 'org-1' },
        error: null,
      })),
    }
    const settingsQuery = makeSettingsQuery({ data: null })
    from.mockImplementation((table) => {
      if (table === 'users') return userQuery
      if (table === 'pharmacy_settings') return settingsQuery
      throw new Error(`Unexpected table ${table}`)
    })

    await expect(getPharmacyThemeSettings()).resolves.toBeNull()

    expect(settingsQuery.insert).not.toHaveBeenCalled()
  })
})
