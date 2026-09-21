// Accreditation generated/issue date: explicit, independent, never derived.
//
// effective  - derived from the credential code (display only)
// generated  - stored: nhia_configuration.accreditation_date_generated
// expiry     - stored: nhia_configuration.accreditation_expiry_date
// West Point legitimately has effective 2025-12-01, generated 2025-12-29, expiry 2027-12-01.
// HEALTH LIGHT LTD (030509386) currently stores generated = expiry = 2027-08-01: flagged for
// review (ACCREDITATION_DATE_REVIEW_REQUIRED), never auto-corrected.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { readCxf, phpText } from '../../scripts/lib/cxf-reader.mjs'

vi.mock('../lib/supabase', () => ({
  getCachedSupabaseSession: () => null,
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))
vi.mock('../services/auditService', () => ({ tryLogAuditEvent: vi.fn() }))
vi.mock('../services/branchServerApi', () => ({
  createBranchRecord: vi.fn(), deleteBranchRecord: vi.fn(), getNhiaSettings: vi.fn(), listBranchRecords: vi.fn(),
  saveNhiaSettings: vi.fn(), shouldUseBranchServer: vi.fn(() => false), submitNhiaDirectPayload: vi.fn(),
  updateBranchNhisClaimMedicines: vi.fn(), updateBranchRecord: vi.fn(),
}))
vi.mock('../services/apiRouter', () => ({ routeWrite: vi.fn(async ({ local }) => await local()) }))
vi.mock('../services/connectivityService', () => ({
  getConnectivityState: vi.fn(() => ({ mode: 'ONLINE_LOCAL_SYNC', internetAvailable: true, branchServerAvailable: true, checkedAt: Date.now() })),
  refreshConnectivityState: vi.fn(async () => ({ mode: 'ONLINE_LOCAL_SYNC', internetAvailable: true, branchServerAvailable: true, checkedAt: Date.now() })),
}))
vi.mock('../services/tierAccessService', () => ({ invokeTierAccess: vi.fn() }))

import NhiaAccreditationDatesFields from '../components/NhiaAccreditationDatesFields'
import {
  ACCREDITATION_DATE_REVIEW_REQUIRED, ACCREDITATION_GENERATED_MISSING, ACCREDITATION_GENERATED_IN_FUTURE,
  ACCREDITATION_GENERATED_INVALID, getAccreditationDateIssues, getAccreditationEffectiveDateFromCredentialCode,
  describeIncompleteClaimItConfiguration, ACCREDITATION_GENERATED_MISSING_MESSAGE,
} from '../utils/nhiaAccreditationDates'
import { applyNhiaFacilityDefaults, getNhiaAccreditationDateGenerated } from '../utils/nhiaFacilityDefaults'
import {
  assertClaimItCxfExportConfigured, buildNhisClaimItCxf, buildNhisClaimItExportPayload,
  getClaimItAccreditationDiagnostics, getNhiaApiSettings, saveNhiaApiSettings,
} from '../services/nhisService'
import { invokeTierAccess } from '../services/tierAccessService'
import { getNhiaSettings, shouldUseBranchServer } from '../services/branchServerApi'
import { getConnectivityState } from '../services/connectivityService'

const WEST_POINT = { credentialCode: '03-05-001-02-01954-11-P1-2-011225', effective: '2025-12-01', generated: '2025-12-29', expiry: '2027-12-01' }
const HEALTH_LIGHT = { credentialCode: '03-05-001-02-09386-11-P1-2-011025', effective: '2025-10-01', generated: '2027-08-01', expiry: '2027-08-01' }

const Harness = ({ initial = {}, spy, credentialCode = WEST_POINT.credentialCode, requireGenerated = true }) => {
  const [dates, setDates] = useState({ accreditationDateGenerated: '', accreditationExpiryDate: '', ...initial })
  return (
    <NhiaAccreditationDatesFields
      credentialCode={credentialCode}
      generatedDate={dates.accreditationDateGenerated}
      expiryDate={dates.accreditationExpiryDate}
      requireGenerated={requireGenerated}
      onChange={(field, value) => { spy?.(field, value); setDates((current) => ({ ...current, [field]: value })) }}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  shouldUseBranchServer.mockReturnValue(false)
  window.localStorage.clear()
})

describe('Settings UI: labelled, independent accreditation dates', () => {
  it('shows visible labels for effective, generated/issue and expiry dates (not placeholder/tooltip/aria only)', () => {
    render(<Harness initial={{ accreditationDateGenerated: WEST_POINT.generated, accreditationExpiryDate: WEST_POINT.expiry }} />)
    const root = screen.getByTestId('nhia-accreditation-dates')
    for (const label of ['Accreditation Effective Date', 'Accreditation Generated / Issue Date', 'Accreditation Expiry Date']) {
      expect(within(root).getByText(label)).toBeVisible()
    }
    // Real <label> association, not aria-label-only.
    expect(screen.getByLabelText('Accreditation Generated / Issue Date')).toHaveValue(WEST_POINT.generated)
    expect(screen.getByLabelText('Accreditation Expiry Date')).toHaveValue(WEST_POINT.expiry)
    expect(root.querySelector('input[aria-label], input[placeholder], input[title]')).toBeNull()
  })

  it('explains the generated date without telling users to copy effective or expiry', () => {
    render(<Harness />)
    expect(screen.getByText('Enter the accreditation generated/issue date exactly as shown on the NHIA accreditation record.')).toBeVisible()
    expect(screen.queryByText(/copy|same as|use the (effective|expiry)/i)).toBeNull()
  })

  it('shows the effective date as read-only and derived from the credential code (stored elsewhere: not editable here)', () => {
    render(<Harness />)
    expect(screen.getByTestId('accreditation-effective-date')).toHaveTextContent(WEST_POINT.effective)
    expect(screen.getByText(/not stored separately and is not edited here/i)).toBeVisible()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(2)
  })

  it('binds generated and expiry separately and never copies one into the other', () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    fireEvent.change(screen.getByLabelText('Accreditation Expiry Date'), { target: { value: '2027-12-01' } })
    expect(spy).toHaveBeenLastCalledWith('accreditationExpiryDate', '2027-12-01')
    expect(screen.getByLabelText('Accreditation Generated / Issue Date')).toHaveValue('') // untouched
    fireEvent.change(screen.getByLabelText('Accreditation Generated / Issue Date'), { target: { value: '2025-12-29' } })
    expect(spy).toHaveBeenLastCalledWith('accreditationDateGenerated', '2025-12-29')
    expect(screen.getByLabelText('Accreditation Expiry Date')).toHaveValue('2027-12-01')
    expect(spy.mock.calls.map(([field]) => field)).toEqual(['accreditationExpiryDate', 'accreditationDateGenerated'])
  })

  it('warns (never corrects) when generated equals expiry, keeping the entered value', () => {
    render(<Harness initial={{ accreditationDateGenerated: HEALTH_LIGHT.generated, accreditationExpiryDate: HEALTH_LIGHT.expiry }} credentialCode={HEALTH_LIGHT.credentialCode} />)
    const warning = screen.getByText(/Generated date is the same as expiry date\. Please verify this against the NHIA accreditation record\./)
    expect(warning).toBeVisible()
    expect(warning).toHaveAttribute('data-issue', ACCREDITATION_DATE_REVIEW_REQUIRED)
    expect(screen.getByLabelText('Accreditation Generated / Issue Date')).toHaveValue(HEALTH_LIGHT.generated)
    expect(screen.getByLabelText('Accreditation Expiry Date')).toHaveValue(HEALTH_LIGHT.expiry)
  })

  it('reports a missing generated date in plain language when export requires it', () => {
    render(<Harness initial={{ accreditationExpiryDate: WEST_POINT.expiry }} />)
    const message = screen.getByText(ACCREDITATION_GENERATED_MISSING_MESSAGE)
    expect(message).toHaveAttribute('data-issue', ACCREDITATION_GENERATED_MISSING)
    expect(message.textContent).not.toMatch(/accreditationDateGenerated/)
    expect(screen.getByLabelText('Accreditation Generated / Issue Date')).toHaveValue('') // not filled from expiry
  })

  it('shows no warning for the proven West Point pattern', () => {
    render(<Harness initial={{ accreditationDateGenerated: WEST_POINT.generated, accreditationExpiryDate: WEST_POINT.expiry }} />)
    expect(document.querySelector('[data-issue]')).toBeNull()
  })
})

describe('validation rules', () => {
  const codes = (input) => getAccreditationDateIssues({ today: '2026-09-21', ...input }).map((issue) => issue.code)

  it('accepts the West Point trio with independent dates and reports nothing', () => {
    expect(getAccreditationEffectiveDateFromCredentialCode(WEST_POINT.credentialCode)).toBe(WEST_POINT.effective)
    expect(codes({ generated: WEST_POINT.generated, expiry: WEST_POINT.expiry, effective: WEST_POINT.effective })).toEqual([])
    expect(new Set([WEST_POINT.effective, WEST_POINT.generated, WEST_POINT.expiry]).size).toBe(3)
  })

  it('flags Health Light generated = expiry (and future) as suspicious diagnostics, not errors', () => {
    const issues = getAccreditationDateIssues({ generated: HEALTH_LIGHT.generated, expiry: HEALTH_LIGHT.expiry, effective: HEALTH_LIGHT.effective, today: '2026-09-21' })
    expect(issues.map((issue) => issue.code)).toEqual([ACCREDITATION_DATE_REVIEW_REQUIRED, ACCREDITATION_GENERATED_IN_FUTURE])
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true)
    expect(issues[0].diagnostic).toBe('Generated date matches expiry date. Verify against original NHIA accreditation record.')
  })

  it('requires the generated date only when export needs it and rejects malformed dates', () => {
    expect(codes({ generated: '', expiry: '2027-12-01' })).toEqual([])
    expect(codes({ generated: '', expiry: '2027-12-01', requireGenerated: true })).toEqual([ACCREDITATION_GENERATED_MISSING])
    for (const bad of ['2025-02-30', '25-12-29', '1999-01-01', '2101-01-01', '2025-13-01', 'yesterday']) {
      expect(codes({ generated: bad, expiry: '2027-12-01' }), bad).toContain(ACCREDITATION_GENERATED_INVALID)
    }
  })

  it('does not hard-block on equality and never returns a replacement value', () => {
    const issues = getAccreditationDateIssues({ generated: '2027-08-01', expiry: '2027-08-01', today: '2026-09-21' })
    expect(issues.some((issue) => issue.severity === 'error')).toBe(false)
    expect(JSON.stringify(issues)).not.toMatch(/replacement|suggest/i)
  })
})

describe('no automatic fallback for dateGenerated', () => {
  it('getter and facility defaults ignore effective/expiry keys and organization data', () => {
    const sources = { accreditationExpiryDate: '2027-08-01', accreditationExpiry: '2027-08-01', accreditation_expiry_date: '2027-08-01', expiryDate: '2027-08-01', effectiveDate: '2025-10-01', accreditationEffectiveDate: '2025-10-01' }
    expect(getNhiaAccreditationDateGenerated(sources)).toBe('')
    expect(getNhiaAccreditationDateGenerated({}, sources)).toBe('')
    expect(applyNhiaFacilityDefaults({ ...sources, credentialCode: HEALTH_LIGHT.credentialCode }, { name: 'Org' }).accreditationDateGenerated).toBe('')
  })

  it('export refuses a missing generated date with a human-readable message instead of substituting one', () => {
    const options = { organizationType: 'pharmacy', facilityType: 'Pharmacy', pharmacyFacilityLevel: 'P1', facilityCode: HEALTH_LIGHT.credentialCode, credentialCode: HEALTH_LIGHT.credentialCode, providerNumber: '03-05-09386', facilityName: 'F', providerLevelCode: 'PVT-PHC-CE', claimsOfficerName: 'C', accreditationExpiryDate: '2027-08-01' }
    let error
    try { assertClaimItCxfExportConfigured(options) } catch (caught) { error = caught }
    expect(error.message).toBe(ACCREDITATION_GENERATED_MISSING_MESSAGE)
    expect(error.message).not.toMatch(/accreditationDateGenerated/)
    expect(error.code).toBe('NHIA_CONFIG_INCOMPLETE')
    expect(error.missingFields).toEqual(['accreditationDateGenerated'])
    expect(() => assertClaimItCxfExportConfigured({ ...options, accreditationDateGenerated: '2025-10-05' })).not.toThrow()
  })

  it('translates internal names when several fields are missing', () => {
    const text = describeIncompleteClaimItConfiguration(['facilityName', 'accreditationDateGenerated', 'credentialCode'])
    expect(text).toContain('facility name, accreditation generated/issue date, CLAIM-it credential code')
    expect(text).not.toMatch(/accreditationDateGenerated|credentialCode|facilityName/)
  })
})

describe('export payload and serializer keep the explicit dateGenerated', () => {
  const claim = {
    id: 'c1', claim_number: 'P-1', status: 'served', organization_type: 'pharmacy',
    claimit_attachment_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'), member_no: '12345678', ccc_no: '12345',
    surname: 'S', other_names: 'P', gender: 'female', date_of_birth: '1990-01-01', service_date_from: '2026-07-26', service_date_to: '2026-07-26', total_amount: 10,
    nhis_claim_medicines: [{ drug_code: 'X', description: 'x', unit: 't', unit_price: 10, dispensed_qty: 1, total_amount: 10, dose: '1', frequency: 'OD', duration: '1 day', dispensary_date: '2026-07-26' }],
  }
  const build = (facility, overrides = {}) => ({
    organizationType: 'pharmacy', facilityType: 'Pharmacy', pharmacyFacilityLevel: 'P1', facilityCode: facility.credentialCode, credentialCode: facility.credentialCode,
    providerNumber: '03-05-00001', facilityName: 'Probe', yearMonth: '2026-07', generatedAt: '2026-09-20T06:22:00Z', claimsOfficerName: 'x',
    accreditationExpiryDate: facility.expiry, accreditationDateGenerated: facility.generated, ...overrides,
  })
  const accreditationOf = async (options) => {
    const bundle = readCxf(await buildNhisClaimItCxf(buildNhisClaimItExportPayload([claim], options)))
    const row = [...bundle.get('data').get('_meta').get('accreditations').values()][0]
    return Object.fromEntries(['accred_effectiveDate', 'dateGenerated', 'expiryDate'].map((key) => [key, phpText(row.get(key))]))
  }

  it('West Point: effective, generated and expiry stay three independent values in the CXF', async () => {
    expect(await accreditationOf(build(WEST_POINT))).toEqual({ accred_effectiveDate: '2025-12-01', dateGenerated: '2025-12-29', expiryDate: '2027-12-01' })
  })

  it('the payload carries the explicit stored value, not a derived one', () => {
    const payload = buildNhisClaimItExportPayload([claim], build(WEST_POINT))
    expect(payload.accreditationDateGenerated).toBe('2025-12-29')
    expect(payload.accreditationExpiryDate).toBe('2027-12-01')
  })

  it('Health Light: the suspicious stored value is exported exactly as stored and diagnosed (warning only)', async () => {
    expect(await accreditationOf(build(HEALTH_LIGHT))).toEqual({ accred_effectiveDate: '2025-10-01', dateGenerated: '2027-08-01', expiryDate: '2027-08-01' })
    const [diagnostic] = getClaimItAccreditationDiagnostics(buildNhisClaimItExportPayload([claim], build(HEALTH_LIGHT)))
    expect(diagnostic.warnings).toEqual(expect.arrayContaining([ACCREDITATION_DATE_REVIEW_REQUIRED, ACCREDITATION_GENERATED_IN_FUTURE]))
    expect(diagnostic.messages).toContain('Generated date matches expiry date. Verify against original NHIA accreditation record.')
  })

  it('does not warn for West Point', () => {
    expect(getClaimItAccreditationDiagnostics(buildNhisClaimItExportPayload([claim], build(WEST_POINT)))).toEqual([])
  })

  it('effective date shown in Settings equals the one the serializer emits (single derivation rule)', async () => {
    for (const facility of [WEST_POINT, HEALTH_LIGHT]) {
      expect((await accreditationOf(build(facility))).accred_effectiveDate).toBe(getAccreditationEffectiveDateFromCredentialCode(facility.credentialCode))
    }
  })
})

describe('save/load round trip keeps dateGenerated independent', () => {
  const stored = (extra = {}) => ({
    organizationId: 'org-1', facilityCode: 'FAC-1', providerId: 'P-1', providerNumber: 'P-1', credentialCode: WEST_POINT.credentialCode,
    accreditationDateGenerated: WEST_POINT.generated, accreditationExpiryDate: WEST_POINT.expiry, claimsOfficerName: 'Officer', ...extra,
  })

  it('sends the generated date to the cloud save as its own key and reads it back with the expiry unchanged', async () => {
    invokeTierAccess.mockResolvedValue({ settings: stored() })
    const saved = await saveNhiaApiSettings(stored(), { organizationId: 'org-1' })
    const request = invokeTierAccess.mock.calls.find(([body]) => body.action === 'save_nhia_api_settings')[0]
    expect(request.settings.accreditationDateGenerated).toBe('2025-12-29')
    expect(request.settings.accreditationExpiryDate).toBe('2027-12-01')
    expect(saved).toMatchObject({ accreditationDateGenerated: '2025-12-29', accreditationExpiryDate: '2027-12-01' })
    const loaded = await getNhiaApiSettings({ organizationId: 'org-1', forceRefresh: true })
    expect(loaded).toMatchObject({ accreditationDateGenerated: '2025-12-29', accreditation_date_generated: '2025-12-29', accreditationExpiryDate: '2027-12-01' })
  })

  it('keeps the stored value through refresh from the local cache (no network)', async () => {
    invokeTierAccess.mockResolvedValue({ settings: stored() })
    await getNhiaApiSettings({ organizationId: 'org-1', forceRefresh: true })
    const cached = JSON.parse(window.localStorage.getItem('healthflow.nhiaApiSettings.v3:org-1')).settings
    expect(cached).toMatchObject({ accreditationDateGenerated: '2025-12-29', accreditationExpiryDate: '2027-12-01' })
    invokeTierAccess.mockClear()
    expect(await getNhiaApiSettings({ organizationId: 'org-1' })).toMatchObject({ accreditationDateGenerated: '2025-12-29' })
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('offline: reads the generated date from the branch server, then from cache when the branch server is unreachable', async () => {
    shouldUseBranchServer.mockReturnValue(true)
    getNhiaSettings.mockResolvedValueOnce(stored())
    expect(await getNhiaApiSettings({ organizationId: 'org-1' })).toMatchObject({ accreditationDateGenerated: '2025-12-29', accreditationExpiryDate: '2027-12-01' })
    getConnectivityState.mockReturnValue({ internetAvailable: false, branchServerAvailable: false, checkedAt: Date.now() })
    getNhiaSettings.mockRejectedValueOnce(new Error('branch server offline'))
    expect(await getNhiaApiSettings({ organizationId: 'org-1' })).toMatchObject({ accreditationDateGenerated: '2025-12-29', accreditationExpiryDate: '2027-12-01' })
  })

  it('offline settings without a generated date stay empty (no fallback to expiry)', async () => {
    shouldUseBranchServer.mockReturnValue(true)
    getNhiaSettings.mockResolvedValueOnce(stored({ accreditationDateGenerated: undefined }))
    const loaded = await getNhiaApiSettings({ organizationId: 'org-1' })
    expect(loaded.accreditationDateGenerated).toBe('')
    expect(loaded.accreditationExpiryDate).toBe('2027-12-01')
  })
})
