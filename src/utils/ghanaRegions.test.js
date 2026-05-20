import { describe, expect, it } from 'vitest'
import { GHANA_REGIONS, normalizeGhanaRegion } from './ghanaRegions'

describe('ghanaRegions', () => {
  it('lists the official 16 Ghana regions', () => {
    expect(GHANA_REGIONS).toHaveLength(16)
    expect(GHANA_REGIONS).toContain('Greater Accra')
    expect(GHANA_REGIONS).toContain('Western North')
  })

  it('normalizes legacy casing and spacing to the official region labels', () => {
    expect(normalizeGhanaRegion('GREATER ACCRA')).toBe('Greater Accra')
    expect(normalizeGhanaRegion(' bono-east ')).toBe('Bono East')
    expect(normalizeGhanaRegion('WESTERN NORTH')).toBe('Western North')
  })
})
