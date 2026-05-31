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

  it('applies Ghana NHIS API defaults when an existing organization has no NHIA row', () => {
    const resolved = applyNhiaFacilityDefaults(null, {
      name: 'Existing Pharmacy',
      organization_type: 'pharmacy',
      license_number: 'LIC-2026',
    })

    expect(resolved.apiBaseUrl).toBe('https://elig.nhia.gov.gh:5000')
    expect(resolved.memberLookupEndpointPath).toBe('/api/hmis/genCCC')
    expect(resolved.claimitSubmitBaseUrl).toBe('http://localhost:31719/json-api')
    expect(resolved.claimEndpointPath).toBe('/claims')
    expect(resolved.integrationMode).toBe('claimit_assisted')
    expect(resolved.credentialMode).toBe('claimit_token')
    expect(resolved.credentials.headerName).toBe('x-nhia-apikey')
    expect(resolved.credentials.secretHeaderName).toBe('x-nhia-apisecret')
    expect(resolved.credentials.tokenEndpointPath).toBe('/token')
    expect(resolved.schemeName).toBe('National Health Insurance')
    expect(resolved.admissionPaymentOption).toBe('nhis_pays_admission')
    expect(resolved.facilityType).toBe('Pharmacy')
    expect(resolved.licenseNumber).toBe('LIC-2026')
    expect(resolved.pharmacyFacilityLevel).toBe('P1')
  })

  it('does not overwrite existing NHIA and CLAIM-it endpoint choices', () => {
    const resolved = applyNhiaFacilityDefaults({
      apiBaseUrl: 'https://custom-elig.example',
      memberLookupEndpointPath: '/custom/genCCC',
      claimitSubmitBaseUrl: 'http://branch-pc:31719/json-api',
      claimEndpointPath: '/custom-claims',
      integrationMode: 'claimit_bridge',
      credentials: {
        headerName: 'x-custom-key',
        secretHeaderName: 'x-custom-secret',
      },
    }, {
      organization_type: 'pharmacy',
    })

    expect(resolved.apiBaseUrl).toBe('https://custom-elig.example')
    expect(resolved.memberLookupEndpointPath).toBe('/custom/genCCC')
    expect(resolved.claimitSubmitBaseUrl).toBe('http://branch-pc:31719/json-api')
    expect(resolved.claimEndpointPath).toBe('/custom-claims')
    expect(resolved.integrationMode).toBe('claimit_bridge')
    expect(resolved.credentials.headerName).toBe('x-custom-key')
    expect(resolved.credentials.secretHeaderName).toBe('x-custom-secret')
  })

  it('does not carry pharmacy P-level defaults into hospital facilities', () => {
    const resolved = applyNhiaFacilityDefaults({
      facilityType: 'Pharmacy',
      pharmacyFacilityLevel: 'P1',
      providerClassLevel: 'B2',
    }, {
      name: 'Central Hospital',
      organization_type: 'hospital',
    })

    expect(resolved.facilityType).toBe('Hospital')
    expect(resolved.pharmacyFacilityLevel).toBe('')
    expect(resolved.providerClassLevel).toBe('B2')
  })
})
