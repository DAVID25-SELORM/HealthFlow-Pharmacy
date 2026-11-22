import { describe, expect, it } from 'vitest'
import { INTERFACE_FLAGS, isInterfaceFlagOn, usesClassicNavigation } from './interfaceFlags'

describe('interface flags', () => {
  it('uses the current interface when nothing is set', () => {
    expect(usesClassicNavigation(undefined)).toBe(false)
    expect(usesClassicNavigation(null)).toBe(false)
    expect(usesClassicNavigation({})).toBe(false)
    expect(usesClassicNavigation({ interface_flags: null })).toBe(false)
    expect(usesClassicNavigation({ interface_flags: {} })).toBe(false)
  })

  it('only switches on for a real true', () => {
    expect(usesClassicNavigation({ interface_flags: { classic_navigation: true } })).toBe(true)
    expect(usesClassicNavigation({ interface_flags: { classic_navigation: false } })).toBe(false)
    expect(usesClassicNavigation({ interface_flags: { classic_navigation: 'true' } })).toBe(false)
    expect(usesClassicNavigation({ interface_flags: { classic_navigation: 1 } })).toBe(false)
  })

  it('reads any named flag', () => {
    expect(isInterfaceFlagOn({ interface_flags: { other: true } }, 'other')).toBe(true)
    expect(isInterfaceFlagOn({ interface_flags: { other: true } }, INTERFACE_FLAGS.classicNavigation)).toBe(false)
  })
})
