import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../lib/supabase', () => ({
  getCachedSupabaseSession: () => null,
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('./branchServerApi', () => ({
  createBranchRecord: vi.fn(),
  deleteBranchRecord: vi.fn(),
  getNhiaSettings: vi.fn(),
  listBranchRecords: vi.fn(),
  saveNhiaSettings: vi.fn(),
  shouldUseBranchServer: vi.fn(() => false),
  submitNhiaDirectPayload: vi.fn(),
  updateBranchNhisClaimMedicines: vi.fn(),
  updateBranchRecord: vi.fn(),
}))

vi.mock('./apiRouter', () => ({
  routeWrite: vi.fn(async ({ local }) => await local()),
}))

vi.mock('./connectivityService', () => ({
  getConnectivityState: vi.fn(() => ({
    mode: 'ONLINE_LOCAL_SYNC',
    internetAvailable: true,
    branchServerAvailable: true,
    checkedAt: Date.now(),
  })),
  refreshConnectivityState: vi.fn(async () => ({
    mode: 'ONLINE_LOCAL_SYNC',
    internetAvailable: true,
    branchServerAvailable: true,
    checkedAt: Date.now(),
  })),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess: vi.fn(),
}))

import { supabase } from '../lib/supabase'
import {
  buildNhisDurationRepairReview, normalizeClaimItDurationForExport,
  validateNhisMedicineDurationInput, checkNhisExportReadiness,
  exportNhisClaimsFile, applyNhisDurationRepairs,
} from './nhisService'

beforeEach(() => vi.clearAllMocks())

// Aggregate values from the July diagnostic; contains no patient records.
const historicalValues = [['90',247],['1',1],['10',1],['120',6],['14',1],
  ['15',3],['180',3],['2',1],['20',8],['21',4],['3',2],['30',119],
  ['36',2],['48',2],['5',1],['60',113],['72',2],['31 Days',1],['4 WEEKS',1]]

it.each(['facility-a', 'facility-b', 'facility-c'])(
  'accepts the complete historical distribution for %s without writes', (organization_id) => {
    const medicines = historicalValues.flatMap(([duration,count]) =>
      Array.from({length:count}, () => Object.freeze({duration})))
    const claim = Object.freeze({ organization_id, nhis_claim_medicines: Object.freeze(medicines) })
    expect(buildNhisDurationRepairReview([claim])).toMatchObject({
      valuesScanned: 518, alreadyValid: 518, manualReview: 0, automaticallyCorrected: 0,
    })
    for (const medicine of medicines) {
      const exported = normalizeClaimItDurationForExport(medicine.duration)
      expect(exported.unit).toBe('DAYS')
      expect(exported.value).toMatch(/^[1-9][0-9]*\.00$/)
    }
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

it.each([null, '', 'invalid', '0', '-30'])(
  'blocks the whole prepared batch for unresolved duration %s', async (duration) => {
    const claims = [{ nhis_claim_medicines: [{duration:'90'}, {duration}] }]
    const options = { preparedReadiness: {
      claims, duplicateGroups: [], exportBlockingIssues: [],
      period: {label:'July'}, format:'cxf', directSubmit:false,
    } }
    await expect(checkNhisExportReadiness(options)).rejects.toThrow(/require repair/)
    await expect(exportNhisClaimsFile(options)).rejects.toThrow(/repair and review/)
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

it('keeps bare historical numbers out of new clinical entry and correction writes', async () => {
  expect(validateNhisMedicineDurationInput('90')).not.toBe('')
  expect(validateNhisMedicineDurationInput('90 days')).toBe('')
  await expect(applyNhisDurationRepairs([
    {medicineId:'synthetic', originalValue:null, newValue:'90'},
  ])).rejects.toThrow(/positive whole number/)
  expect(supabase.rpc).not.toHaveBeenCalled()
})
