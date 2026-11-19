import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_GROUP,
  SETTINGS_GROUPS,
  getAvailableSettingsGroups,
  resolveSettingsGroup,
  settingsGroupFromHash,
} from './settingsSections'

describe('settings sections', () => {
  it('lists every group for an admin', () => {
    expect(getAvailableSettingsGroups({ isAdmin: true }).map((g) => g.id)).toEqual(
      SETTINGS_GROUPS.map((g) => g.id)
    )
  })

  it('lists only Facility and My account for other staff', () => {
    expect(getAvailableSettingsGroups({ isAdmin: false }).map((g) => g.id)).toEqual(['facility', 'account'])
    expect(getAvailableSettingsGroups().map((g) => g.id)).toEqual(['facility', 'account'])
  })

  it('opens the right section for page anchors used by other links', () => {
    expect(settingsGroupFromHash('#offline-access')).toBe('account')
    expect(settingsGroupFromHash('#staff')).toBe('staff')
    expect(settingsGroupFromHash('#unknown')).toBe('')
    expect(settingsGroupFromHash('')).toBe('')
  })

  it('falls back to Facility when the requested section is not available', () => {
    const staffView = getAvailableSettingsGroups({ isAdmin: false })
    expect(resolveSettingsGroup('integrations', staffView)).toBe(DEFAULT_SETTINGS_GROUP)
    expect(resolveSettingsGroup('account', staffView)).toBe('account')
  })
})
