import { describe, expect, it } from 'vitest'
import { applyNhiaFacilityDefaults, hasNhiaFacilitySettings } from './nhiaFacilityDefaults'

describe('NHIA facility defaults', () => {
  it('seeds Westpoint CLAIM-it codes from the organization identity', () => {
    const resolved = applyNhiaFacilityDefaults(null, {
      name: 'WESTPOINT CHEMIST',
      subdomain: 'westpoint',
    })

    expect(resolved.facilityCode).toBe('03-05-001-02-01954-11-P1-2-011225')
    expect(resolved.providerNumber).toBe('03-05-01954')
    expect(resolved.providerTypeDescription).toBe('Pharmacy')
  })

  it('keeps explicitly saved facility settings ahead of known defaults', () => {
    const resolved = applyNhiaFacilityDefaults({
      facilityCode: 'custom-facility',
      providerNumber: 'custom-provider',
      providerTypeDescription: 'Private clinics',
    }, {
      name: 'Westpoint Chemist',
    })

    expect(resolved.facilityCode).toBe('custom-facility')
    expect(resolved.providerNumber).toBe('custom-provider')
    expect(resolved.providerTypeDescription).toBe('Private clinics')
  })

  it('uses organization NHIA fields for any configured facility', () => {
    const resolved = applyNhiaFacilityDefaults(null, {
      name: 'Another Facility',
      claimit_facility_code: 'facility-from-org',
      nhia_provider_number: 'provider-from-org',
      provider_type_description: 'Pharmacy',
    })

    expect(resolved.facilityCode).toBe('facility-from-org')
    expect(resolved.providerNumber).toBe('provider-from-org')
    expect(hasNhiaFacilitySettings(resolved)).toBe(true)
  })
})
