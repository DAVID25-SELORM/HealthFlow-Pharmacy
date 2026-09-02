import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  announceFacilityThemeUpdate,
  applyFacilityTheme,
  DEFAULT_FACILITY_THEME,
  FACILITY_THEME_UPDATED_EVENT,
  getReadableForeground,
  isValidThemeColor,
} from './facilityTheme'

describe('facility theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('applies distinct branding colors and derived primary shades', () => {
    applyFacilityTheme({
      theme_primary_color: '#0000cc',
      theme_secondary_color: '#6633cc',
      theme_accent_color: '#99aaff',
    })

    const style = document.documentElement.style
    expect(style.getPropertyValue('--primary')).toBe('#0000cc')
    expect(style.getPropertyValue('--primary-dark')).not.toBe('#0000cc')
    expect(style.getPropertyValue('--primary-light')).not.toBe('#0000cc')
    expect(style.getPropertyValue('--secondary')).toBe('#6633cc')
    expect(style.getPropertyValue('--accent')).toBe('#99aaff')
    expect(style.getPropertyValue('--on-primary')).toBe('#ffffff')
    expect(style.getPropertyValue('--on-accent')).toBe('#111827')
    expect(style.getPropertyValue('--warning')).toBe('')
  })

  it('resets malformed or missing colors to safe defaults', () => {
    expect(isValidThemeColor('#16a085')).toBe(true)
    expect(isValidThemeColor('red')).toBe(false)
    expect(applyFacilityTheme({ theme_primary_color: 'not-a-color' })).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
      DEFAULT_FACILITY_THEME.primary
    )
    expect(document.documentElement.style.getPropertyValue('--secondary')).toBe(
      DEFAULT_FACILITY_THEME.secondary
    )
  })

  it('chooses readable text for light and dark branding colors', () => {
    expect(getReadableForeground('#ffffff')).toBe('#111827')
    expect(getReadableForeground('#000000')).toBe('#ffffff')
  })

  it('clears the previous organization theme when the next has no branding', () => {
    applyFacilityTheme({ theme_primary_color: '#abcdef' })
    applyFacilityTheme(null)

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
      DEFAULT_FACILITY_THEME.primary
    )
  })

  it('applies and announces saved theme changes immediately', () => {
    const listener = vi.fn()
    window.addEventListener(FACILITY_THEME_UPDATED_EVENT, listener)
    const settings = { themePrimaryColor: '#123456' }

    announceFacilityThemeUpdate(settings)

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#123456')
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].detail).toBe(settings)
    window.removeEventListener(FACILITY_THEME_UPDATED_EVENT, listener)
  })
})
