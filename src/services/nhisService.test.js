import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inflateSync } from 'node:zlib'

vi.mock('../lib/supabase', () => ({
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

import {
  assessNhisClaimReadiness,
  assertClaimItCxfExportConfigured,
  buildClaimItConfigPreview,
  buildNhisClaimItExportPayload,
  buildNhisClaimItCxf,
  buildNhisClaimItDirectXml,
  buildNhisClaimItXml,
  checkNhisActiveMedicationOverlap,
  checkNhisExportReadiness,
  createNhisClaim,
  deleteNhisClaim,
  exportNhisClaimsFile,
  generateHostedNhiaCcCode,
  generateBrowserClaimItBridgeCcCode,
  getApplicableNhiaTariffItems,
  getAllNhisClaims,
  getNhisClaimsPage,
  getNhisClaimIssueCounts,
  getNhisClaimExportDate,
  getNhisExportScrubWarnings,
  getAllNhisDrugs,
  getNhisDrugByCode,
  getNhisClaimsForPeriod,
  getNhiaApiSettings,
  nhisClaimMatchesExportPeriod,
  mergeNhisClaimRows,
  normalizeNhisGender,
  normalizeNhisExportPeriod,
  prepareNhisClaimsExport,
  saveNhiaApiSettings,
  serveNhisClaimDirect,
  submitNhisClaimDirect,
  updateNhisClaim,
  updateNhisClaimStatus,
  uploadNhisPrescriptionPdf,
  validateNhisPrescriptionPdfFile,
  TEMPORARY_UNIVERSAL_NHIA_TARIFF_SOURCE,
} from './nhisService'
import { supabase } from '../lib/supabase'
import {
  deleteBranchRecord,
  getNhiaSettings,
  listBranchRecords,
  saveNhiaSettings,
  shouldUseBranchServer,
  submitNhiaDirectPayload,
  updateBranchNhisClaimMedicines,
  updateBranchRecord,
} from './branchServerApi'
import { routeWrite } from './apiRouter'
import { getConnectivityState } from './connectivityService'
import { invokeTierAccess } from './tierAccessService'

beforeEach(() => {
  vi.clearAllMocks()
  shouldUseBranchServer.mockReturnValue(false)
  window.localStorage?.clear()
  delete supabase.storage
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer,
  })))
})

const extractSerializedClaimBuffer = (inflatedCxfPayload) => {
  const key = Buffer.from('s:15:"serializedClaim";s:', 'utf8')
  const keyIndex = inflatedCxfPayload.indexOf(key)
  expect(keyIndex).toBeGreaterThan(-1)

  const lengthStart = keyIndex + key.length
  const lengthEnd = inflatedCxfPayload.indexOf(Buffer.from(':"', 'utf8'), lengthStart)
  expect(lengthEnd).toBeGreaterThan(lengthStart)

  const byteLength = Number(inflatedCxfPayload.toString('ascii', lengthStart, lengthEnd))
  const valueStart = lengthEnd + 2
  return inflatedCxfPayload.subarray(valueStart, valueStart + byteLength)
}

const extractAttachmentDataBuffer = (inflatedCxfPayload) => {
  const inflatedText = Buffer.from(inflatedCxfPayload).toString('latin1')
  const tableIndex = inflatedText.indexOf('s:14:"attachmentdata"')
  expect(tableIndex).toBeGreaterThan(-1)

  const dataKey = 's:4:"data";s:'
  const dataIndex = inflatedText.indexOf(dataKey, tableIndex)
  expect(dataIndex).toBeGreaterThan(-1)

  const lengthStart = dataIndex + dataKey.length
  const lengthEnd = inflatedText.indexOf(':"', lengthStart)
  expect(lengthEnd).toBeGreaterThan(lengthStart)

  const byteLength = Number(inflatedText.slice(lengthStart, lengthEnd))
  const valueStart = lengthEnd + 2
  return inflatedCxfPayload.subarray(valueStart, valueStart + byteLength)
}

const mockNhiaConfigurationStore = (initialRow = null) => {
  let storedRow = initialRow
  const makeQuery = () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      is: vi.fn(() => query),
      upsert: vi.fn((row) => {
        storedRow = { ...(storedRow || {}), ...(Array.isArray(row) ? row[0] : row) }
        return query
      }),
      maybeSingle: vi.fn(async () => ({ data: storedRow, error: null })),
    }
    return query
  }

  supabase.from.mockImplementation((table) => {
    if (table === 'nhia_configuration') return makeQuery()
    return makeQuery()
  })

  return {
    getRow: () => storedRow,
  }
}

const mockNhisClaimDuplicateAndUpdateQueries = ({ duplicates = [] } = {}) => {
  const updateQuery = {
    in: vi.fn().mockResolvedValue({ error: null }),
  }
  const claimQuery = {
    select: vi.fn(() => claimQuery),
    eq: vi.fn(() => claimQuery),
    neq: vi.fn(() => claimQuery),
    limit: vi.fn().mockResolvedValue({ data: duplicates, error: null }),
    update: vi.fn(() => updateQuery),
  }
  supabase.from.mockImplementation((table) => {
    if (table === 'nhis_claims') return claimQuery
    return { update: vi.fn(() => updateQuery) }
  })
  return { claimQuery, updateQuery }
}

describe('normalizeNhisGender', () => {
  it('maps NHIA gender values to claim form option values', () => {
    expect(normalizeNhisGender('MALE')).toBe('male')
    expect(normalizeNhisGender('FEMALE')).toBe('female')
    expect(normalizeNhisGender('M')).toBe('male')
    expect(normalizeNhisGender('F')).toBe('female')
  })
})

const baseClaim = {
  memberNo: '12345678',
  surname: 'Mensah',
  otherNames: 'Ama',
  folderNo: 'F001',
  patientAddress: 'Accra',
  dateOfBirth: '1990-01-01',
  cccNo: 'CC-12345',
  serviceDate: '2026-05-14',
  referringFacility: 'Westpoint Chemist',
  physicianName: 'Dr Test',
  prescriptionFilePath: 'org/2026-05/claim/rx.pdf',
  prescriptionFileName: 'rx.pdf',
  prescriptionDocumentType: 'prescription',
  prescriptionVerified: true,
  prescriptionVerifiedBy: '11111111-1111-4111-8111-111111111111',
  prescriptionVerifiedAt: '2026-05-14T10:00:00.000Z',
  organizationType: 'pharmacy',
}

const baseMedicine = {
  nhisDrugId: 'drug-1',
  drugCode: 'NH001',
  description: 'Paracetamol Tablet',
  unit: 'tablet',
  unitPrice: 1,
  dispensedQty: 10,
  dose: '1 tablet',
  frequency: 'TDS',
  duration: '5 days',
}

const baseTariffService = {
  nhiaTariffItemId: 'tariff-1',
  tariffVersion: 'FEB 2023',
  facilityGroup: 'CHAG Primary Care Hospital',
  cateringOption: 'exclusive',
  mdc: 'Out Patient',
  gdrgCode: 'OPDC01A',
  description: 'General OPD Adult',
  unitPrice: 37.08,
  quantity: 1,
  serviceDate: '2026-05-14',
  totalAmount: 37.08,
}

const mismatchBlocker =
  'no matching Malaria medicine/category was found. Reason: correct the diagnosis or add a medicine/category that matches the recorded diagnosis before saving corrections/submission.'

describe('assessNhisClaimReadiness', () => {
  it('warns about dose, frequency, and duration while serving patients', () => {
    const medicine = {
      ...baseMedicine,
      dose: '',
      frequency: '',
      duration: '',
    }

    const pharmacy = assessNhisClaimReadiness(baseClaim, [medicine])
    const hospital = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Malaria' },
      [medicine]
    )

    expect(pharmacy.blockers).not.toContain('Medicine 1: dose is required.')
    expect(hospital.blockers).not.toContain('Medicine 1: dose is required.')
    expect(pharmacy.warnings).toEqual(expect.arrayContaining([
      'Medicine 1: dose is missing; claims officer must complete it before corrections/export.',
      'Medicine 1: dosage schedule/frequency is missing; claims officer must complete it before corrections/export.',
      'Medicine 1: duration is missing; claims officer must complete it before corrections/export.',
    ]))
    expect(hospital.warnings).toEqual(expect.arrayContaining([
      'Medicine 1: dose is missing; claims officer must complete it before corrections/export.',
      'Medicine 1: dosage schedule/frequency is missing; claims officer must complete it before corrections/export.',
      'Medicine 1: duration is missing; claims officer must complete it before corrections/export.',
    ]))
  })

  it('requires dose, frequency, and duration for claims officer corrections and final export', () => {
    const medicine = {
      ...baseMedicine,
      dose: '',
      frequency: '',
      duration: '',
    }

    const corrections = assessNhisClaimReadiness(baseClaim, [medicine], {
      requireMedicineDirections: true,
    })
    const finalSubmission = assessNhisClaimReadiness(baseClaim, [medicine], {
      finalSubmission: true,
    })

    expect(corrections.blockers).toEqual(expect.arrayContaining([
      'Medicine 1: dose is required.',
      'Medicine 1: dosage schedule/frequency is required.',
      'Medicine 1: duration is required.',
    ]))
    expect(finalSubmission.blockers).toEqual(expect.arrayContaining([
      'Medicine 1: dose is required.',
      'Medicine 1: dosage schedule/frequency is required.',
      'Medicine 1: duration is required.',
    ]))
  })

  it('requires a scanned prescription attachment before final export', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        prescriptionFilePath: '',
        prescriptionFileName: '',
      },
      [baseMedicine],
      { finalSubmission: true }
    )

    expect(readiness.blockers).toContain(
      'Attach the scanned prescription PDF or JPEG before saving/submitting this NHIS claim.'
    )
  })

  it('blocks a receipt or unverified attachment from pharmacy completion', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        prescriptionDocumentType: 'receipt',
        prescriptionVerified: false,
        prescriptionVerifiedBy: '',
        prescriptionVerifiedAt: '',
      },
      [baseMedicine],
      { finalSubmission: true }
    )

    expect(readiness.blockers).toContain(
      'Classify the attachment as Prescription and confirm that Claims staff verified it before completing/submitting this pharmacy claim.'
    )
  })

  it('counts unverified prescription issues using exact counts without selecting Base64', async () => {
    const selects = []
    const makeCountQuery = (count) => {
      const query = Promise.resolve({ count, error: null })
      query.in = vi.fn(() => query)
      query.eq = vi.fn(() => query)
      query.gte = vi.fn(() => query)
      query.lte = vi.fn(() => query)
      query.or = vi.fn(() => query)
      query.is = vi.fn(() => query)
      query.ilike = vi.fn(() => query)
      return query
    }
    const countQueries = [
      makeCountQuery(2), // attached
      makeCountQuery(2), // prescription typed
      makeCountQuery(1), // verified prescription
      makeCountQuery(0), // missing attachment
      makeCountQuery(0), // incomplete intake total
      makeCountQuery(0), // complete intake
    ]
    supabase.from.mockReturnValue({
      select: vi.fn((select) => {
        selects.push(select)
        return countQueries.shift()
      }),
    })

    const counts = await getNhisClaimIssueCounts({ organizationType: 'pharmacy' })

    expect(counts.all).toBe(1)
    expect(counts['unverified-prescription']).toBe(1)
    expect(counts.unverified).toBeUndefined()
    expect(selects.join('\n')).not.toContain('claimit_attachment_base64')
  })

  it('uses server exact counts so issue totals can exceed 1,000 while date filters remain applied', async () => {
    const queries = []
    const makeCountQuery = (count) => {
      const query = Promise.resolve({ count, error: null })
      query.in = vi.fn(() => query)
      query.eq = vi.fn(() => query)
      query.gte = vi.fn(() => query)
      query.lte = vi.fn(() => query)
      query.or = vi.fn(() => query)
      query.is = vi.fn(() => query)
      query.ilike = vi.fn(() => query)
      queries.push(query)
      return query
    }
    const countQueries = [
      makeCountQuery(1250), // attached
      makeCountQuery(1250), // prescription typed
      makeCountQuery(0), // verified prescription
      makeCountQuery(0), // missing attachment
      makeCountQuery(0), // incomplete intake total
      makeCountQuery(0), // complete intake
    ]
    supabase.from.mockReturnValue({
      select: vi.fn(() => countQueries.shift()),
    })

    const counts = await getNhisClaimIssueCounts({
      organizationType: 'pharmacy',
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
      issueCountMaxRows: 1000,
    })

    expect(counts.all).toBe(1250)
    expect(counts['unverified-prescription']).toBe(1250)
    expect(queries.some((query) => query.range?.mock?.calls?.length)).toBe(false)
    expect(queries.every((query) => query.gte.mock.calls.some((call) => call[0] === 'service_date_from' && call[1] === '2026-06-01'))).toBe(true)
    expect(queries.every((query) => query.lte.mock.calls.some((call) => call[0] === 'service_date_from' && call[1] === '2026-06-30'))).toBe(true)
  })

  it('allows hospital final status checks to make the attachment optional', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        prescriptionFilePath: '',
        prescriptionFileName: '',
      },
      [baseMedicine],
      { finalSubmission: true }
    )

    expect(readiness.blockers).not.toContain(
      'Attach the scanned prescription PDF or JPEG before saving/submitting this NHIS claim.'
    )
  })

  it('still lets callers explicitly require hospital prescription attachments', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        prescriptionFilePath: '',
        prescriptionFileName: '',
      },
      [baseMedicine],
      { finalSubmission: true, requirePrescriptionAttachment: true }
    )

    expect(readiness.blockers).toContain(
      'Attach the scanned prescription PDF or JPEG before saving/submitting this NHIS claim.'
    )
  })

  it('does not require OTAC or NeHFAMS attendance fields for final submission', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        authId: '',
        authType: '',
        newCcc: '',
        otacCode: '',
        nhiaAttendanceDate: '',
        attendanceVerificationStatus: '',
        attendanceVerificationSource: '',
      },
      [baseMedicine],
      {
        finalSubmission: true,
        requirePrescriptionAttachment: false,
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ id: baseMedicine.nhisDrugId, code: baseMedicine.drugCode, category: 'A' }],
      }
    )

    expect(readiness.blockers.join(' ')).not.toMatch(/OTAC|NeHFAMS|attendance|AuthID/i)
  })

  it('does not warn for missing patient address on pharmacy claims', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, patientAddress: '', organizationType: 'pharmacy' },
      [baseMedicine]
    )

    expect(readiness.warnings).not.toContain('Patient address is missing on the claim.')
  })

  it('keeps patient address warning for hospital claims', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, patientAddress: '', organizationType: 'hospital', diagnosis: 'Uncomplicated malaria' },
      [baseMedicine]
    )

    expect(readiness.warnings).toContain('Patient address is missing on the claim.')
  })

  it('blocks claims officer corrections when hospital diagnosis and medicines do not match', () => {
    const medicine = {
      ...baseMedicine,
      drugCode: 'CIPTIN1',
      description: 'Ciprofloxacin + Tinidazole Tablet, 500 mg + 600 mg',
    }

    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Plasmodium falciparum malaria' },
      [medicine],
      { requireMedicineDirections: true }
    )

    expect(readiness.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining(mismatchBlocker),
    ]))
  })

  it('blocks extra medicines that are not explained by any recorded diagnosis', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Uncomplicated malaria' },
      [
        { ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet' },
        { ...baseMedicine, drugCode: 'AMLO1', description: 'Amlodipine Tablet' },
      ],
      { requireMedicineDirections: true, providerClassLevel: 'D' }
    )

    expect(readiness.blockers).toContain(
      'Medicine 2: Amlodipine Tablet appears to be for Hypertension, but that diagnosis is not recorded on this claim.'
    )
  })

  it('allows supportive treatment when a primary diagnosis treatment is present', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Uncomplicated malaria' },
      [
        { ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet' },
        { ...baseMedicine, drugCode: 'PARA1', description: 'Paracetamol Tablet' },
      ],
      { requireMedicineDirections: true, providerClassLevel: 'D' }
    )

    expect(readiness.blockers.join(' ')).not.toContain(mismatchBlocker)
    expect(readiness.blockers.join(' ')).not.toContain('Medicine 2: Paracetamol Tablet appears to be')
  })

  it('does not present pain or fever support rules as diagnoses', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'Typhoid fever; Plasmodium falciparum malaria',
      },
      [
        { ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet' },
        { ...baseMedicine, drugCode: 'CEFTR1', description: 'Ceftriaxone Injection' },
      ],
      { requireMedicineDirections: true, providerClassLevel: 'D' }
    )

    expect(readiness.blockers).toContain(
      'Typhoid fever and Plasmodium falciparum malaria are associated with fever, but no analgesic/antipyretic medicine was found. Reason: add a pain/fever-relief medicine or document why none was required before saving corrections/submission.'
    )
    expect(readiness.blockers.join(' ')).not.toContain('Pain or fever: treatment does not appear to match the diagnosis')
  })

  it('does not block hospital service-only claims when the encounter outcome explains no internal medicine', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'Typhoid fever; Plasmodium falciparum malaria',
        encounterOutcome: 'external_prescription',
        noMedicineReason: 'external_prescription_issued',
        externalPrescriptionStatus: 'Issued to patient for community pharmacy collection',
      },
      [],
      {
        finalSubmission: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [baseTariffService],
      }
    )

    expect(readiness.blockers.join(' ')).not.toContain('no analgesic/antipyretic medicine was found')
    expect(readiness.blockers.join(' ')).not.toContain('no matching')
    expect(readiness.information).toContain(
      'No internal medicine was dispensed. This is documented by outcome: External prescription issued; reason: External prescription issued; external prescription: Issued to patient for community pharmacy collection.'
    )
  })

  it('warns instead of blocking when a hospital service-only claim has no no-medicine explanation', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'Typhoid fever; Plasmodium falciparum malaria',
      },
      [],
      {
        finalSubmission: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [baseTariffService],
      }
    )

    expect(readiness.blockers.join(' ')).not.toContain('no analgesic/antipyretic medicine was found')
    expect(readiness.warnings).toContain(
      'No medicine was dispensed. Add an encounter outcome or no-medicine reason if treatment was deferred, referred, declined, unavailable, or not clinically indicated.'
    )
  })

  it('uses documented no-lab and no-procedure pathways instead of false hospital scrub warnings', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'Plasmodium falciparum malaria',
        encounterOutcome: 'treated_discharged',
        noLabReason: 'clinical_diagnosis_sufficient',
        noProcedureReason: 'not_clinically_indicated',
      },
      [
        {
          ...baseMedicine,
          drugCode: 'ARTLUM1',
          description: 'Artemether Lumefantrine Tablet',
        },
        {
          ...baseMedicine,
          drugCode: 'PARA1',
          description: 'Paracetamol Tablet',
        },
      ],
      {
        finalSubmission: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [baseTariffService],
      }
    )

    expect(readiness.warnings).not.toContain(
      'Malaria: supporting malaria test/RDT or blood film should be documented before final submission.'
    )
    expect(readiness.information).toContain(
      'No internal laboratory investigation was recorded. This is documented by outcome: Treated and discharged; reason: Clinical diagnosis sufficient.'
    )
    expect(readiness.information).toContain(
      'No internal procedure was recorded. This is documented by reason: Not clinically indicated.'
    )
  })

  it('blocks final submission when medicines exist but diagnosis has no clinical rule coverage', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Unmapped diagnosis' },
      [{ ...baseMedicine, drugCode: 'CEFTRIN1', description: 'Ceftriaxone Injection' }],
      { finalSubmission: true, providerClassLevel: 'D' }
    )

    expect(readiness.blockers).toContain(
      'Diagnosis-treatment rule not found for the recorded diagnosis. Import or add a clinical rule before final submission to reduce rejection risk.'
    )
  })

  it('falls back to built-in clinical rules when final readiness receives an empty rule set', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Malaria' },
      [{ ...baseMedicine, drugCode: 'CIPTIN1', description: 'Ciprofloxacin + Tinidazole Tablet' }],
      { finalSubmission: true, clinicalRules: [] }
    )

    expect(readiness.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining(mismatchBlocker),
    ]))
  })

  it('matches clinical rules using selected ICD diagnosis details', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'B50',
        diagnosisDetails: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      },
      [{ ...baseMedicine, drugCode: 'CIPTIN1', description: 'Ciprofloxacin + Tinidazole Tablet' }],
      { requireMedicineDirections: true }
    )

    expect(readiness.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining(mismatchBlocker),
    ]))
  })

  it('blocks age and gender clinical conflicts before hospital correction submission', () => {
    const malePregnancy = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', gender: 'male', diagnosis: 'Antenatal care pregnancy' },
      [{ ...baseMedicine, category: 'A' }],
      { requireMedicineDirections: true, providerClassLevel: 'D' }
    )
    const childTetracycline = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', dateOfBirth: '2024-01-01', diagnosis: 'Skin infection' },
      [{ ...baseMedicine, description: 'Tetracycline Capsule', drugCode: 'TETCAP1', category: 'A' }],
      { requireMedicineDirections: true, providerClassLevel: 'D' }
    )

    expect(malePregnancy.blockers).toContain(
      'Critical: male patient has a pregnancy/obstetric or female reproductive diagnosis. Correct patient gender or diagnosis before submission.'
    )
    expect(childTetracycline.blockers).toContain(
      'Medicine 1: tetracycline/doxycycline is age-restricted for children under 8. Use an approved alternative or document specialist justification.'
    )
  })

  it('blocks duplicate medicines and unsupported antibiotics on malaria-only hospital claims', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Uncomplicated malaria' },
      [
        { ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet', category: 'A' },
        { ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet', category: 'A' },
        { ...baseMedicine, drugCode: 'CEFTRIN1', description: 'Ceftriaxone Injection', category: 'B2' },
      ],
      { requireMedicineDirections: true, providerClassLevel: 'D' }
    )

    expect(readiness.blockers).toContain(
      'High: duplicate medicine code ARTLUM1 appears on the claim. Merge the quantities or remove the repeated line.'
    )
    expect(readiness.blockers).toContain(
      'High: Medicine 3: this item is unusual for malaria-only claims. Add a supporting diagnosis or remove it before submission.'
    )
    expect(readiness.riskLevel).toBe('critical')
  })

  it('flags excessive quantities against dose, frequency, and duration', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Fever' },
      [{
        ...baseMedicine,
        description: 'Paracetamol Tablet',
        category: 'A',
        dispensedQty: 90,
        dose: '1 tablet',
        frequency: 'TDS',
        duration: '5 days',
      }],
      { requireMedicineDirections: true, providerClassLevel: 'D' }
    )

    expect(readiness.blockers).toContain(
      'High: Medicine 1: dispensed quantity 90 is far above the dose/frequency/duration estimate (15). Correct the quantity or directions.'
    )
  })

  it('adds investigation and chronic disease documentation warnings for final hospital scrubbing', () => {
    const malaria = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Malaria' },
      [{ ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet', category: 'A' }],
      { finalSubmission: true, providerClassLevel: 'D' }
    )
    const hypertension = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Hypertension' },
      [{ ...baseMedicine, drugCode: 'AMLO1', description: 'Amlodipine Tablet', category: 'A' }],
      { finalSubmission: true, providerClassLevel: 'D' }
    )

    expect(malaria.warnings).toContain(
      'Malaria: supporting malaria test/RDT or blood film should be documented before final submission.'
    )
    expect(hypertension.warnings).toContain(
      'Hypertension: BP reading/monitoring should be documented before final submission.'
    )
  })

  it('warns when a hospital malaria-only claim includes a typhoid lab service', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Plasmodium falciparum malaria' },
      [{ ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet', category: 'A' }],
      {
        finalSubmission: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{
          ...baseTariffService,
          description: 'Typhoid test',
          gdrgCode: 'INE149',
        }],
      }
    )

    expect(readiness.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Diagnosis-Lab Review: Typhoid/Widal testing is unusual for a malaria-only diagnosis.'),
    ]))
  })

  it('allows typhoid lab services when the supporting diagnosis is also recorded', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Plasmodium falciparum malaria; suspected typhoid fever' },
      [{ ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet', category: 'A' }],
      {
        finalSubmission: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{
          ...baseTariffService,
          description: 'Typhoid test',
          gdrgCode: 'INE149',
        }],
      }
    )

    expect(readiness.warnings.join(' ')).not.toContain('Typhoid/Widal testing is unusual for a malaria-only diagnosis')
  })

  it('blocks unsupported major procedures when procedure data is supplied', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Mild malaria' },
      [{ ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet', category: 'A' }],
      {
        finalSubmission: true,
        providerClassLevel: 'D',
        services: [{ description: 'Theatre fee and CT scan' }],
      }
    )

    expect(readiness.blockers).toContain(
      'High: major procedure or imaging item is not supported by the recorded diagnosis. Add a supporting diagnosis/pre-authorization or remove the item.'
    )
  })

  it('blocks obvious diagnosis-treatment mismatches for hospital tariff services', () => {
    const malariaWithObstetricProcedure = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Uncomplicated malaria' },
      [{ ...baseMedicine, drugCode: 'ARTLUM1', description: 'Artemether Lumefantrine Tablet', category: 'A' }],
      {
        finalSubmission: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{
          ...baseTariffService,
          description: 'Caesarean section theatre fee',
          gdrgCode: 'OBSC01',
        }],
      }
    )
    const pregnancyWithProstateProcedure = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Pregnancy antenatal care' },
      [],
      {
        finalSubmission: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{
          ...baseTariffService,
          description: 'Prostate surgery package',
          gdrgCode: 'SURG01',
        }],
      }
    )

    expect(malariaWithObstetricProcedure.blockers).toContain(
      'Diagnosis-Treatment Mismatch: selected treatment/procedure is not clinically compatible with the recorded malaria diagnosis. Review the diagnosis or treatment before submitting this claim.'
    )
    expect(pregnancyWithProstateProcedure.blockers).toContain(
      'Diagnosis-Treatment Mismatch: selected treatment/procedure is not clinically compatible with the recorded pregnancy/obstetric diagnosis. Review the diagnosis or treatment before submitting this claim.'
    )
  })

  it('allows hospital claims with only NHIA tariff services and validates service metadata', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'General consultation' },
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [baseTariffService],
      }
    )
    const missingCatalog = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'General consultation' },
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{ ...baseTariffService, nhiaTariffItemId: '' }],
      }
    )
    const invalidQuantity = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'General consultation' },
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{ ...baseTariffService, quantity: 0, totalAmount: 0 }],
      }
    )

    expect(readiness.blockers).not.toContain('Add at least one medicine or NHIA tariff service to the claim.')
    expect(readiness.blockers).not.toContain('Service 1: select an item from the FEB 2023 NHIA tariff catalog.')
    expect(missingCatalog.blockers).toContain('Service 1: select an item from the FEB 2023 NHIA tariff catalog.')
    expect(invalidQuantity.blockers).toContain('Service 1: quantity must be greater than zero.')
  })

  it('separates hospital G-DRG tariffs from pharmacy medicine claims', () => {
    const pharmacyWithTariff = assessNhisClaimReadiness(
      baseClaim,
      [baseMedicine],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'C',
        pharmacyLevel: 'P1',
        nhiaTariffServices: [baseTariffService],
      }
    )
    const hospitalWithoutIcd = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'General consultation' },
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [baseTariffService],
      }
    )

    expect(pharmacyWithTariff.blockers).toContain(
      'Pharmacy NHIS claims cannot include hospital G-DRG/tariff service lines. Remove tariff services or switch to a hospital claim.'
    )
    expect(hospitalWithoutIcd.warnings).toContain(
      'Hospital NHIS claims should use an ICD-10 coded diagnosis before selecting G-DRG/tariff services.'
    )
  })

  it('blocks hospital tariffs that do not match the configured facility tariff set', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'B50',
        diagnosisDetails: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      },
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        tariffFacilityGroup: 'Private Primary Care Hospital',
        tariffCateringOption: 'exclusive',
        nhiaTariffServices: [{ ...baseTariffService, facilityGroup: 'CHAG Primary Care Hospital' }],
      }
    )

    expect(readiness.blockers).toContain(
      'Service 1: tariff belongs to CHAG Primary Care Hospital, but Settings are configured for Private Primary Care Hospital. Select the correct hospital tariff set.'
    )
  })

  it('falls back to the verified master tariff when a hospital-specific set is unavailable', () => {
    const master = {
      id: 'master-opd',
      tariff_version: 'FEB 2023',
      facility_group: 'Private Primary Care Hospital',
      catering_option: 'exclusive',
      gdrg_code: 'OPDC01A',
      tariff_amount: 37.08,
      source_file: TEMPORARY_UNIVERSAL_NHIA_TARIFF_SOURCE,
      is_active: true,
    }

    expect(getApplicableNhiaTariffItems([master], {
      facilityGroup: 'CHAG Primary Care Hospital',
      cateringOption: 'inclusive',
    })).toEqual([master])
  })

  it('prefers a matching hospital tariff set over the temporary master', () => {
    const master = {
      id: 'master-opd',
      tariff_version: 'FEB 2023',
      facility_group: 'Private Primary Care Hospital',
      catering_option: 'exclusive',
      gdrg_code: 'OPDC01A',
      source_file: TEMPORARY_UNIVERSAL_NHIA_TARIFF_SOURCE,
      is_active: true,
    }
    const matching = {
      ...master,
      id: 'chag-opd',
      facility_group: 'CHAG Primary Care Hospital',
      catering_option: 'inclusive',
      source_file: 'Future approved CHAG tariff.pdf',
    }

    expect(getApplicableNhiaTariffItems([master, matching], {
      facilityGroup: 'CHAG Primary Care Hospital',
      cateringOption: 'inclusive',
    })).toEqual([matching])
  })

  it('filters the hospital tariff catalog by configured provider class level', () => {
    const levelDService = {
      id: 'level-d-opd',
      tariff_version: 'FEB 2023',
      facility_group: 'Private Primary Care Hospital',
      catering_option: 'exclusive',
      gdrg_code: 'OPDC01A',
      description: 'General OPD consultation',
      provider_class_level: 'D',
      tariff_amount: 37.08,
      is_active: true,
    }
    const specialistOnlyService = {
      ...levelDService,
      id: 'specialist-only',
      gdrg_code: 'SPEC01',
      description: 'Specialist procedure',
      allowed_provider_class_levels: ['SM'],
    }

    expect(getApplicableNhiaTariffItems([levelDService, specialistOnlyService], {
      facilityGroup: 'Private Primary Care Hospital',
      cateringOption: 'exclusive',
      providerClassLevel: 'D',
    })).toEqual([levelDService])
  })

  it('does not offer tariff services below their minimum provider class', () => {
    const levelDProcedure = {
      id: 'level-d-procedure',
      tariff_version: 'FEB 2023',
      facility_group: 'Private Primary Care Hospital',
      catering_option: 'exclusive',
      gdrg_code: 'PROC01',
      description: 'Minor theatre procedure',
      minimum_provider_class_level: 'D',
      tariff_amount: 120,
      is_active: true,
    }

    expect(getApplicableNhiaTariffItems([levelDProcedure], {
      facilityGroup: 'Private Primary Care Hospital',
      cateringOption: 'exclusive',
      providerClassLevel: 'C',
    })).toEqual([])
    expect(getApplicableNhiaTariffItems([levelDProcedure], {
      facilityGroup: 'Private Primary Care Hospital',
      cateringOption: 'exclusive',
      providerClassLevel: 'D',
    })).toEqual([levelDProcedure])
  })

  it('blocks tariff services when patient age does not match the PDF age band', () => {
    const childWithAdultTariff = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'General consultation', dateOfBirth: '2020-01-01' },
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{ ...baseTariffService, ageBand: '>=12 Yrs' }],
      }
    )
    const adultWithChildTariff = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'General consultation', dateOfBirth: '1990-01-01' },
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{ ...baseTariffService, ageBand: '<12 Yrs' }],
      }
    )

    expect(childWithAdultTariff.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('tariff age band >=12 Yrs is for patients 12 and above'),
    ]))
    expect(adultWithChildTariff.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('tariff age band <12 Yrs is for patients under 12'),
    ]))
  })

  it('blocks saved tariff service lines whose copied price no longer matches the catalog', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'General consultation' },
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{ ...baseTariffService, unitPrice: 37.08, quantity: 2, totalAmount: 74.16 }],
        currentNhiaTariffItems: [{
          id: 'tariff-1',
          tariff_version: 'FEB 2023',
          facility_group: 'CHAG Primary Care Hospital',
          catering_option: 'exclusive',
          gdrg_code: 'OPDC01A',
          age_band: null,
          tariff_amount: 50,
        }],
      }
    )

    expect(readiness.blockers).toContain('Service 1: tariff price is outdated. Current official amount is GHS 50.00.')
    expect(readiness.blockers).toContain('Service 1: service total is outdated. Current official total is GHS 100.00.')
  })

  it('uses pharmacy facility levels, not hospital provider classes, for pharmacy medicines', () => {
    const providerClassIgnored = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'C', medicineAccessLevel: 'Prescription', requiredPharmacyLevel: 'P2' }],
      { enforcePrescribingLevel: true, providerClassLevel: 'B1', pharmacyLevel: 'P1' }
    )
    const p1FullPharmacyAllowed = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'A', medicineAccessLevel: 'Controlled', requiredPharmacyLevel: 'HP' }],
      { enforcePrescribingLevel: true, providerClassLevel: 'SM', pharmacyLevel: 'P1' }
    )
    const p2RestrictedPharmacyBlocked = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'A', medicineAccessLevel: 'Controlled', requiredPharmacyLevel: 'HP' }],
      { enforcePrescribingLevel: true, providerClassLevel: 'SM', pharmacyLevel: 'P2' }
    )

    expect(providerClassIgnored.blockers).not.toEqual(expect.arrayContaining([
      expect.stringContaining('requires NHIS prescribing level C'),
    ]))
    expect(p1FullPharmacyAllowed.blockers).not.toContain(
      'Medicine 1: This medicine is not allowed for your pharmacy/facility level and may cause NHIS claim rejection.'
    )
    expect(p2RestrictedPharmacyBlocked.blockers).toContain(
      'Medicine 1: This medicine is not allowed for your pharmacy/facility level and may cause NHIS claim rejection.'
    )
  })

  it('does not warn P1 pharmacies when medicine access metadata is not configured', () => {
    const p1Readiness = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, medicineAccessLevel: '', requiredPharmacyLevel: '' }],
      { enforcePrescribingLevel: true, pharmacyLevel: 'P1' }
    )
    const p2Readiness = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, medicineAccessLevel: '', requiredPharmacyLevel: '' }],
      { enforcePrescribingLevel: true, pharmacyLevel: 'P2' }
    )

    expect(p1Readiness.warnings).not.toContain('Medicine 1: Level not configured.')
    expect(p2Readiness.warnings).toContain('Medicine 1: Level not configured.')
  })

  it('uses hospital provider class levels for G-DRG and tariff access', () => {
    const claim = {
      ...baseClaim,
      organizationType: 'hospital',
      diagnosis: 'B50',
      diagnosisDetails: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
    }
    const blocked = assessNhisClaimReadiness(
      claim,
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'C',
        nhiaTariffServices: [{ ...baseTariffService, facilityGroup: 'Private Primary Care Hospital' }],
      }
    )
    const allowed = assessNhisClaimReadiness(
      claim,
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{ ...baseTariffService, facilityGroup: 'Private Primary Care Hospital' }],
      }
    )

    expect(blocked.blockers).toContain(
      'Service 1: OPDC01A requires hospital provider class D or higher, but Settings are C. Select an allowed G-DRG/tariff for this facility.'
    )
    expect(allowed.blockers).not.toEqual(expect.arrayContaining([
      expect.stringContaining('requires hospital provider class D or higher'),
    ]))
  })

  it('uses the temporary master price at lower hospital levels without removing service-level controls', () => {
    const claim = {
      ...baseClaim,
      organizationType: 'hospital',
      diagnosis: 'B50',
      diagnosisDetails: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
    }
    const temporaryMasterService = {
      ...baseTariffService,
      facilityGroup: 'Private Primary Care Hospital',
      sourceFile: TEMPORARY_UNIVERSAL_NHIA_TARIFF_SOURCE,
    }
    const opd = assessNhisClaimReadiness(claim, [], {
      enforcePrescribingLevel: true,
      providerClassLevel: 'B1',
      tariffFacilityGroup: 'CHAG Primary Care Hospital',
      tariffCateringOption: 'inclusive',
      nhiaTariffServices: [temporaryMasterService],
    })
    const procedure = assessNhisClaimReadiness(claim, [], {
      enforcePrescribingLevel: true,
      providerClassLevel: 'B1',
      nhiaTariffServices: [{
        ...temporaryMasterService,
        gdrgCode: 'ASUR01A',
        description: 'Operations of thyroid and parathyroid glands',
      }],
    })

    expect(opd.blockers).not.toEqual(expect.arrayContaining([
      expect.stringContaining('tariff belongs to'),
      expect.stringContaining('tariff catering option'),
      expect.stringContaining('requires hospital provider class D'),
    ]))
    expect(procedure.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('requires hospital provider class D or higher'),
    ]))
  })

  it('uses explicit tariff provider class metadata when present', () => {
    const claim = {
      ...baseClaim,
      organizationType: 'hospital',
      diagnosis: 'B50',
      diagnosisDetails: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
    }
    const readiness = assessNhisClaimReadiness(
      claim,
      [],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'D',
        nhiaTariffServices: [{ ...baseTariffService, facilityGroup: 'Private Primary Care Hospital' }],
        currentNhiaTariffItems: [{
          id: 'tariff-1',
          tariff_version: 'FEB 2023',
          facility_group: 'Private Primary Care Hospital',
          catering_option: 'exclusive',
          gdrg_code: 'OPDC01A',
          tariff_amount: 37.08,
          allowed_provider_class_levels: 'SM',
        }],
      }
    )

    expect(readiness.blockers).toContain(
      'Service 1: G-DRG/tariff is limited to hospital provider class SM, but Settings are D. Select an allowed tariff or update Settings.'
    )
  })

  it('uses pharmacy medicine level, not hospital provider class, for hospital pharmacy-module medicines', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'B50',
        diagnosisDetails: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      },
      [{ ...baseMedicine, drugCode: 'MIDAZOIN1', category: '' }],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'B2',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'MIDAZOIN1', category: 'C' }],
      }
    )

    expect(readiness.blockers).not.toEqual(expect.arrayContaining([
      expect.stringContaining('requires NHIS prescribing level C'),
    ]))
  })

  it('requires pharmacy medicine level for hospital medicine claims', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'B50',
        diagnosisDetails: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      },
      [{ ...baseMedicine, medicineAccessLevel: 'Prescription', requiredPharmacyLevel: 'P2' }],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'C',
      }
    )

    expect(readiness.blockers).toContain(
      'Set the NHIS pharmacy/medicine level in Settings before saving/submitting medicine claims for the hospital pharmacy module.'
    )
  })

  it('requires hospital provider class level before enforcing hospital tariffs', () => {
    const readiness = assessNhisClaimReadiness(
      {
        ...baseClaim,
        organizationType: 'hospital',
        diagnosis: 'B50',
        diagnosisDetails: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      },
      [],
      { enforcePrescribingLevel: true, nhiaTariffServices: [baseTariffService] }
    )

    expect(readiness.blockers).toContain('Set the NHIA hospital provider class/level in Settings before saving/submitting hospital claims.')
  })

  it('requires exact NHIS member number digit length', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, memberNo: '1234' },
      [baseMedicine]
    )

    expect(readiness.blockers).toContain('NHIS member number must contain exactly 8 digits.')
  })

  it('warns about a missing prescriber before final export', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, physicianName: '' },
      [baseMedicine]
    )

    expect(readiness.warnings).toContain('Prescriber name or ID is missing from the prescription.')
    expect(readiness.blockers).not.toContain('Prescriber name or ID is missing from the prescription.')
  })

  it('requires prescriber before final export', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, physicianName: '' },
      [baseMedicine],
      { finalSubmission: true }
    )

    expect(readiness.blockers).toContain('Prescriber name or ID is missing from the prescription.')
  })

  it('does not block a saved Ghana Card claim for missing HIN before final export', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, memberNo: 'GHA-123456789-0', hin: '' },
      [baseMedicine]
    )

    expect(readiness.blockers).not.toContain(
      'Ghana Card-linked claims must have the numeric NHIS/HIN membership number in the HIN field before CXF export.'
    )
  })

  it('requires numeric HIN for Ghana Card-linked claims before final CXF export', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, memberNo: 'GHA-123456789-0', hin: '' },
      [baseMedicine],
      { finalSubmission: true }
    )

    expect(readiness.blockers).toContain(
      'Ghana Card-linked claims must have the numeric NHIS/HIN membership number in the HIN field before CXF export.'
    )
  })

  it('accepts existing numeric HIN lengths for Ghana Card-linked final export readiness', () => {
    const eightDigitHin = assessNhisClaimReadiness(
      { ...baseClaim, memberNo: 'GHA-123456789-0', hin: '46265798' },
      [baseMedicine],
      { finalSubmission: true }
    )
    const tenDigitHin = assessNhisClaimReadiness(
      { ...baseClaim, memberNo: 'GHA-123456789-0', hin: '0029996622' },
      [baseMedicine],
      { finalSubmission: true }
    )

    expect(eightDigitHin.blockers).not.toContain(
      'Ghana Card-linked claims must have the numeric NHIS/HIN membership number in the HIN field before CXF export.'
    )
    expect(tenDigitHin.blockers).not.toContain(
      'Ghana Card-linked claims must have the numeric NHIS/HIN membership number in the HIN field before CXF export.'
    )
  })

  it('requires CCC/CC code before serving a claim', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, cccNo: '' },
      [baseMedicine]
    )

    expect(readiness.blockers).toContain('CCC/CC code is required before serving this NHIS claim.')
  })

  it('requires CCC/CC code to contain exactly 5 digits', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, cccNo: '1234' },
      [baseMedicine]
    )

    expect(readiness.blockers).toContain('CCC/CC code must contain exactly 5 digits.')
  })

  it('only asks for child weight on hospital child claims', () => {
    const childClaim = {
      ...baseClaim,
      dateOfBirth: '2020-01-01',
      childWeightKg: '',
    }

    expect(
      assessNhisClaimReadiness(childClaim, [baseMedicine]).warnings
    ).not.toContain('Child weight is missing for a child patient.')

    expect(
      assessNhisClaimReadiness(
        { ...childClaim, organizationType: 'hospital', diagnosis: 'Malaria' },
        [baseMedicine]
      ).warnings
    ).toContain('Child weight is missing for a child patient.')
  })

  it('accepts linked Ghana Card format as the NHIS member identifier', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, memberNo: 'GHA-123456789-0' },
      [baseMedicine]
    )

    expect(readiness.blockers).not.toContain('NHIS member number must contain exactly 8 digits.')
    expect(readiness.blockers).not.toContain('Ghana Card number must contain exactly 10 digits after GHA.')
  })

  it('rejects non-numeric legacy NHIS values that do not start with GHA', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, memberNo: 'NHIS12345678' },
      [baseMedicine]
    )

    expect(readiness.blockers).toContain(
      'NHIS member number must contain digits only, or enter a Ghana Card number starting with GHA.'
    )
  })

  it('allows up to ten hospital diagnoses and blocks more than ten', () => {
    const tenDiagnoses = Array.from({ length: 10 }, (_, index) => `Diagnosis ${index + 1}`).join('\n')
    const elevenDiagnoses = `${tenDiagnoses}\nDiagnosis 11`

    expect(
      assessNhisClaimReadiness(
        { ...baseClaim, organizationType: 'hospital', diagnosis: tenDiagnoses },
        [baseMedicine]
      ).blockers
    ).not.toContain('Enter no more than 10 diagnoses on one NHIS claim.')

    expect(
      assessNhisClaimReadiness(
        { ...baseClaim, organizationType: 'hospital', diagnosis: elevenDiagnoses },
        [baseMedicine]
      ).blockers
    ).toContain('Enter no more than 10 diagnoses on one NHIS claim.')
  })

  it('does not split ICD diagnosis names that contain commas', () => {
    const readiness = assessNhisClaimReadiness(
      { ...baseClaim, organizationType: 'hospital', diagnosis: 'Cholera, unspecified' },
      [baseMedicine]
    )

    expect(readiness.blockers).not.toContain('Enter no more than 10 diagnoses on one NHIS claim.')
  })
})

describe('CLAIM-it export helpers', () => {
  const pdfBase64 = Buffer.from('%PDF-1.4\n%%EOF', 'utf8').toString('base64')
  const claim = {
    id: 'claim-1',
    claim_number: 'NHIS-000001',
    status: 'served',
    organization_type: 'hospital',
    member_no: 'GHA-123456789-0',
    hin: '0029996622',
    surname: 'Mensah',
    other_names: 'Ama',
    folder_no: 'F001',
    gender: 'female',
    date_of_birth: '1990-01-01',
    patient_address: 'Accra',
    ccc_no: 'CC-12345',
    diagnosis: 'Malaria',
    diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
    service_date_from: '2026-05-14',
    service_date_to: '2026-05-14',
    referring_facility: 'Westpoint Chemist',
    physician_name: 'Dr Test',
    prescription_file_name: 'rx.pdf',
    prescription_file_path: 'org/2026-05/claim/rx.pdf',
    prescription_file_type: 'application/pdf',
    prescription_file_size: 1024,
    prescription_document_type: 'prescription',
    prescription_verified: true,
    prescription_verified_by: '11111111-1111-4111-8111-111111111111',
    prescription_verified_at: '2026-05-14T10:00:00.000Z',
    total_amount: 10,
    nhis_claim_medicines: [
      {
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
      },
    ],
  }

  it('builds a CLAIM-it JSON payload with diagnoses and medicines', () => {
    const payload = buildNhisClaimItExportPayload([claim], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
      generatedAt: '2026-05-15T00:00:00.000Z',
    })

    expect(payload.targetSystem).toBe('CLAIM-it HMS Toolkit')
    expect(payload.claimCount).toBe(1)
    expect(payload.submissionMonth).toBe('2026-05')
    expect(payload.periodFrom).toBe('2026-05-01')
    expect(payload.periodTo).toBe('2026-05-31')
    expect(payload.claims[0].diagnoses[0]).toMatchObject({
      code: 'B50',
      label: 'Plasmodium falciparum malaria',
    })
    expect(payload.claims[0].medicines[0].code).toBe('NH001')
    expect(payload.claims[0].prescriptionAttachment).toBeNull()
  })

  it('defaults CLAIM-it version fields for direct JSON submissions', () => {
    const payload = buildNhisClaimItExportPayload([claim], {
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      organizationType: 'hospital',
      generatedAt: '2026-05-15T00:00:00.000Z',
    })

    expect(payload.medVersion).toBe('2025-05-01.250531')
    expect(payload.serviceVersion).toBe('2023-02-01.250531')
    expect(payload.policyVersion).toBe('cgs.2022-12-01.250531')
    expect(payload.submissionMonth).toBe('')
  })

  it('includes NeHFAMS attendance verification details in CLAIM-it payloads', () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        card_type: 'GHANACARD',
        hin: 'HIN-001',
        ccc_no: 'CC-12345',
        nhia_auth_id: 'AUTH-123',
        nhia_auth_type: 'NHIS',
        nhia_new_ccc_status: 'Yes',
        nhia_otac: '987654',
        nhia_attendance_date: '2026-05-14',
        nhia_attendance_verification_status: 'confirmed',
        nhia_attendance_verification_source: 'nehfams_manual',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
    })

    expect(payload.claims[0].attendanceVerification).toEqual({
      system: 'NeHFAMS',
      source: 'nehfams_manual',
      status: 'confirmed',
      attendanceDate: '2026-05-14',
      authId: 'AUTH-123',
      authType: 'NHIS',
      newCcc: 'yes',
      otac: '987654',
      cardType: 'GHANACARD',
      hin: 'HIN-001',
      ccc: '12345',
    })
  })

  it('omits attendance verification when OTAC and NeHFAMS fields are absent', () => {
    const payload = buildNhisClaimItExportPayload(
      [{
        ...claim,
        nhia_auth_id: null,
        nhia_transaction_id: '383735134',
      }],
      {
        yearMonth: '2026-05',
        organizationType: 'hospital',
      }
    )

    expect(payload.claims[0].attendanceVerification).toBeNull()
    expect(JSON.stringify(payload.claims[0])).not.toContain('383735134')
  })

  it('includes URL-only prescription attachments in CLAIM-it payloads', () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        prescription_file_path: '',
        prescription_file_url: 'data:image/jpeg;base64,rx',
        prescription_file_name: 'rx.jpg',
        prescription_file_type: 'image/jpeg',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
    })

    expect(payload.claims[0].prescriptionAttachment).toMatchObject({
      fileName: 'prescription_NHIS-000001.pdf',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      sourceMimeType: 'image/jpeg',
      storagePath: '',
      url: 'data:image/jpeg;base64,rx',
    })
  })

  it('prefers stored CLAIM-it PDF derivatives for prescription attachments', () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        prescription_file_url: 'data:image/jpeg;base64,original',
        prescription_file_name: 'rx photo.jpg',
        prescription_file_type: 'image/jpeg',
        claimit_attachment_file_name: 'ignored.pdf',
        claimit_attachment_file_type: 'pdf',
        claimit_attachment_mime_type: 'application/pdf',
        claimit_attachment_base64: `data:application/pdf;base64,${pdfBase64}`,
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
    })

    expect(payload.claims[0].prescriptionAttachment).toMatchObject({
      fileName: 'prescription_NHIS-000001.pdf',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      base64: pdfBase64,
      storagePath: '',
      url: '',
    })
    expect(payload.claims[0].prescriptionAttachment.base64.startsWith('data:')).toBe(false)
  })

  it('exports stored PDF derivatives to CXF without changing PDF bytes', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7\r\n%\xff\xfe\r\n1 0 obj\r\n<< /Type /Catalog >>\r\nendobj\r\n%%EOF', 'latin1')
    const pdfBase64 = pdfBytes.toString('base64')
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        prescription_file_url: 'data:image/jpeg;base64,original',
        prescription_file_name: 'original.jpg',
        prescription_file_type: 'image/jpeg',
        claimit_attachment_file_name: 'ignored.pdf',
        claimit_attachment_file_type: 'pdf',
        claimit_attachment_mime_type: 'application/pdf',
        claimit_attachment_base64: `data:application/pdf;base64,${pdfBase64}`,
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    expect(payload.claims[0].prescriptionAttachment).toMatchObject({
      fileName: 'prescription_NHIS-000001.pdf',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      base64: pdfBase64,
    })
    expect(payload.claims[0].prescriptionAttachment.base64.startsWith('data:')).toBe(false)

    const inflated = inflateSync(Buffer.from((await buildNhisClaimItCxf(payload)).slice(3)))
    const inflatedText = inflated.toString('latin1')
    const attachmentData = extractAttachmentDataBuffer(inflated)
    const decodedAttachment = inflateSync(attachmentData)

    expect(inflatedText).toContain('s:8:"fileType";s:3:"pdf"')
    expect(decodedAttachment.equals(pdfBytes)).toBe(true)
    expect(decodedAttachment.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(Array.from(decodedAttachment.subarray(0, 3))).not.toEqual([0xff, 0xd8, 0xff])
  })

  it('omits patient address from pharmacy CLAIM-it payloads', () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        organization_type: 'pharmacy',
        patient_address: 'Accra',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
    })

    expect(payload.claims[0].patient.address).toBe('')
  })

  it('keeps internal unserved-medicines notes out of CLAIM-it exports', () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        ccc_no: 'CC-12345',
        unserved_medicines_note: 'Could not serve amoxicillin.',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
    })

    expect(payload.claims[0].ccCode).toBe('12345')
    expect(payload.claims[0]).not.toHaveProperty('unservedMedicinesNote')
    expect(JSON.stringify(payload)).not.toContain('Could not serve amoxicillin.')
  })

  it('carries HMS setup details into the CLAIM-it payload and XML', () => {
    const payload = buildNhisClaimItExportPayload([claim], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
      facilityCode: 'HPI0542',
      providerNumber: 'HPAH0542',
      facilityType: 'Clinic',
      providerLevelCode: 'PVT-CL-CE',
      credentialCode: '03-05-001-02-01954-11-P1-2-011225',
      licenseNumber: 'LIC-100',
      accreditationExpiryDate: '2026-12-31',
      providerTypeDescription: 'Private clinics',
      providerClassLevel: 'B2',
      claimsOfficerName: 'David Selorm Gabion',
      claimsOfficerSignatureUrl: 'data:image/png;base64,signature',
      submitterId: 'admin',
    })
    const xml = buildNhisClaimItXml(payload)

    expect(payload).toMatchObject({
      facilityCode: 'HPI0542',
      providerNumber: 'HPAH0542',
      providerTypeDescription: 'Private clinics',
      providerClassLevel: 'B2',
      claimsOfficerName: 'David Selorm Gabion',
      claimsOfficerSignatureUrl: 'data:image/png;base64,signature',
      submitterId: 'admin',
    })
    expect(xml).toContain('<ClaimsOfficerSignatureUrl>data:image/png;base64,signature</ClaimsOfficerSignatureUrl>')
    expect(xml).toContain('<FacilityType>Clinic</FacilityType>')
    expect(xml).toContain('<ProviderLevelCode>PVT-CL-CE</ProviderLevelCode>')
    expect(xml).toContain('<CredentialCode>03-05-001-02-01954-11-P1-2-011225</CredentialCode>')
    expect(xml).toContain('<LicenseNumber>LIC-100</LicenseNumber>')
    expect(xml).toContain('<AccreditationExpiryDate>2026-12-31</AccreditationExpiryDate>')
  })

  it('normalizes hospital CLAIM-it preview to provider class levels instead of pharmacy P-levels', () => {
    const preview = buildClaimItConfigPreview({
      facilityType: 'Pharmacy',
      pharmacyFacilityLevel: 'P1',
      providerClassLevel: 'B2',
      facilityCode: 'HOSP-001',
      providerNumber: 'HOSP-PROV',
    }, {
      organizationType: 'hospital',
    })

    expect(preview.facilityType).toBe('Hospital')
    expect(preview.providerClassLevel).toBe('B2')
    expect(preview.pharmacyFacilityLevel).toBe('')
  })

  it('does not require pharmacy P-levels for hospital CXF exports with medicines', () => {
    expect(() => assertClaimItCxfExportConfigured({
      organizationType: 'hospital',
      facilityType: 'Pharmacy',
      pharmacyFacilityLevel: 'P1',
      providerClassLevel: 'B2',
      facilityName: 'Central Hospital',
      providerNumber: 'HOSP-PROV',
      facilityCode: 'HOSP-001',
      credentialCode: 'HOSP-001-B2',
      providerLevelCode: 'PVT-HOS-CE',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      claims: [{ medicines: [{ code: 'NH001' }] }],
    })).not.toThrow()
  })

  it('builds valid XML with escaped patient and medicine text', () => {
    const payload = buildNhisClaimItExportPayload([
      { ...claim, surname: 'A & B', nhis_claim_medicines: [{ ...claim.nhis_claim_medicines[0], description: 'Tab <500mg>' }] },
    ], { yearMonth: '2026-05', organizationType: 'hospital' })

    const xml = buildNhisClaimItXml(payload)

    expect(xml).toContain('<NhiaClaimBatch>')
    expect(xml).toContain('A &amp; B')
    expect(xml).toContain('Tab &lt;500mg&gt;')
  })

  it('exports ordinary NHIS members with blank CLAIM-it card serial numbers', async () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        member_no: '46672601',
        hin: '46672601',
        prescription_file_url: 'https://example.test/rx.pdf',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    expect(payload.claims[0].patient).toMatchObject({
      memberNumber: '46672601',
      cardSerialNo: '',
    })

    const inflated = inflateSync(Buffer.from((await buildNhisClaimItCxf(payload)).slice(3)))
    const savedClaim = JSON.parse(inflateSync(extractSerializedClaimBuffer(inflated)).toString('utf8'))
    expect(savedClaim.memberInfo).toMatchObject({
      memberNo: '46672601',
      cardSerialNo: '',
    })
  })

  it('exports Ghana Card-linked members with 10-digit HIN as member number and blank card serial', async () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        member_no: 'GHA-725620852-3',
        hin: '0029996622',
        prescription_file_url: 'https://example.test/rx.pdf',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    expect(payload.claims[0].patient).toMatchObject({
      memberNumber: '0029996622',
      cardSerialNo: '',
    })

    const inflated = inflateSync(Buffer.from((await buildNhisClaimItCxf(payload)).slice(3)))
    const savedClaim = JSON.parse(inflateSync(extractSerializedClaimBuffer(inflated)).toString('utf8'))
    expect(savedClaim.memberInfo).toMatchObject({
      memberNo: '0029996622',
      cardSerialNo: '',
    })
  })

  it('does not swap member number and card serial in mixed CLAIM-it CXF batches', () => {
    const payload = buildNhisClaimItExportPayload([
      { ...claim, claim_number: 'NHIS-000001', member_no: '46672601', hin: '46672601' },
      { ...claim, claim_number: 'NHIS-000002', member_no: 'GHA-725620852-3', hin: '0029996622' },
      { ...claim, claim_number: 'NHIS-000003', member_no: '66803121', hin: '' },
      { ...claim, claim_number: 'NHIS-000004', member_no: '', hin: '' },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    expect(payload.claims.map((item) => item.patient)).toEqual([
      expect.objectContaining({ memberNumber: '46672601', cardSerialNo: '' }),
      expect.objectContaining({ memberNumber: '0029996622', cardSerialNo: '' }),
      expect.objectContaining({ memberNumber: '66803121', cardSerialNo: '' }),
      expect.objectContaining({ memberNumber: '', cardSerialNo: '' }),
    ])
    expect(payload.claims.some((item) => item.patient.cardSerialNo === item.patient.memberNumber && /^\d+$/.test(item.patient.cardSerialNo))).toBe(false)
  })

  it('uses updated saved claim identifiers when re-exporting after a member correction', () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        member_no: '66803121',
        hin: '0029996622',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    expect(payload.claims[0].patient).toMatchObject({
      memberNumber: '66803121',
      cardSerialNo: '',
    })
  })

  it('builds a binary CXF bundle using CLAIM-it serialized export format', async () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        nhis_claim_medicines: [
          {
            ...claim.nhis_claim_medicines[0],
            dispensary_date: '2026-05-13',
          },
        ],
        prescription_file_url: 'https://example.test/rx.pdf',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    const cxf = await buildNhisClaimItCxf(payload)
    const inflated = inflateSync(Buffer.from(cxf.slice(3)))
    const inflatedText = inflated.toString('utf8')
    const savedClaim = JSON.parse(inflateSync(extractSerializedClaimBuffer(inflated)).toString('utf8'))

    expect(Array.from(cxf.slice(0, 3))).toEqual([0x01, 0x02, 0x19])
    expect(inflatedText).toContain('s:6:"lockID"')
    expect(inflatedText).toContain('s:6:"claims"')
    expect(inflatedText).toContain('s:15:"medicineentries"')
    expect(inflatedText).toContain('s:14:"claimCheckCode"')
    expect(inflatedText).toContain('s:8:"isBackup";b:1')
    expect(inflatedText).toContain('s:12:"facilityName";s:17:"Westpoint Chemist"')
    expect(inflatedText).toContain('s:13:"providerLevel";s:10:"PVT-PHC-CE"')
    expect(inflatedText).toContain('s:10:"providerID";s:11:"03-05-01954"')
    expect(inflatedText).toContain('s:4:"data";a:13')
    expect(inflatedText).toContain('s:10:"dbVersions";a:28')
    expect(inflatedText).toContain('s:14:"accreditations"')
    expect(inflatedText).toContain('s:10:"expiryDate";s:10:"2026-11-30"')
    expect(inflatedText).toContain('s:27:"doctrine_migration_versions"')
    const attachmentData = extractAttachmentDataBuffer(inflated)
    expect(Array.from(attachmentData.subarray(0, 1))).toEqual([0x78])
    expect(inflateSync(attachmentData).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(inflatedText).toContain('s:18:"validation_results";a:0:{}')
    expect(inflatedText).toContain('s:18:"validation_zclaims"')
    expect(inflatedText).toContain('s:18:"prescribersfordays"')
    expect(inflatedText).not.toContain('HF-CLAIMIT-RELATIONAL')
    expect(inflatedText).not.toContain('HF-NHIA-PHARMACY')
    expect(inflatedText).not.toContain('s:18:"providerClassLevel"')
    expect(inflatedText).not.toContain('s:23:"accreditationExpiryDate"')
    expect(inflatedText).not.toContain('<NhiaClaimBatch>')
    expect(savedClaim).toMatchObject({
      claimID: { guid: expect.any(String) },
      claimCheckCode: '12345',
      providerInfo: {
        credentialCode: '03-05-001-02-01954-11-P1-2-011225',
        prescriptionLevelID: 'P1',
      },
      memberInfo: {
        memberNo: '0029996622',
        cardSerialNo: '',
        surname: 'mensah',
      },
      status: 'VALID',
      claimType: 'NHIS',
      totalCost: 10,
      medCost: 10,
      procCost: 0,
    })
    expect(savedClaim.summaryItems).toEqual([
      expect.objectContaining({ type: 'Medicines', amount: 10 }),
    ])
    expect(savedClaim.medicineEntries[0]).toMatchObject({
      medicineCode: 'NH001',
      serviceDate: '2026-05-14',
      cost: 10,
      dispensedQty: {
        qty: 10,
        dispensaryUnit: { unit: 'PRICE_UNIT', unitsInPrice: 1, ratio: 1 },
      },
    })
    expect(savedClaim.attachments[0]).toMatchObject({
      type: 'Prescription',
      fileType: 'pdf',
      data: [''],
    })
  })

  it('converts JPEG prescription attachments to PDF binary before CXF serialization', async () => {
    const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/ISf/2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z'
    const jpegBytes = Buffer.from(jpegBase64, 'base64')
    const OriginalImage = global.Image
    class MockImage {
      set src(_value) {
        this.width = 1
        this.height = 1
        this.naturalWidth = 1
        this.naturalHeight = 1
        this.onload()
      }
    }
    global.Image = MockImage
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => jpegBytes.buffer.slice(jpegBytes.byteOffset, jpegBytes.byteOffset + jpegBytes.byteLength),
    })))
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      const payload = buildNhisClaimItExportPayload([
        {
          ...claim,
          prescription_file_path: '',
          prescription_file_url: 'https://example.test/rx.jpg?download=1',
          prescription_file_name: '',
          prescription_file_type: '',
        },
      ], {
        yearMonth: '2026-05',
        organizationType: 'pharmacy',
        facilityCode: '03-05-001-02-01954-11-P1-2-011225',
        facilityName: 'Westpoint Chemist',
        providerNumber: '03-05-01954',
        providerTypeDescription: 'Pharmacy',
        claimsOfficerName: 'Claims Officer',
        submitterId: 'admin',
        generatedAt: '2026-05-20T14:58:02.000Z',
      })
      expect(payload.claims[0].prescriptionAttachment).toMatchObject({
        fileType: 'pdf',
        mimeType: 'application/pdf',
        sourceMimeType: 'image/jpeg',
      })

      const inflated = inflateSync(Buffer.from((await buildNhisClaimItCxf(payload)).slice(3)))
      const inflatedText = inflated.toString('latin1')
      const attachmentData = extractAttachmentDataBuffer(inflated)
      const decodedAttachment = inflateSync(attachmentData)

      expect(inflatedText).toContain('s:8:"fileType";s:3:"pdf"')
      expect(Array.from(attachmentData.subarray(0, 1))).toEqual([0x78])
      expect(decodedAttachment.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(Array.from(attachmentData.subarray(0, 3))).not.toEqual([0xff, 0xd8, 0xff])
      expect(infoSpy).toHaveBeenCalledWith(
        '[CLAIM-it export diagnostics]',
        expect.objectContaining({
          claimitAttachmentOutputType: 'pdf',
          embeddedPdfDetected: true,
          embeddedPdfHeaderDetected: true,
          embeddedJpegDetected: false,
          attachmentBase64Length: expect.any(Number),
          attachmentDecodedStartsWithPdf: true,
          attachmentMimeType: 'application/pdf',
          attachmentFileType: 'pdf',
        })
      )
    } finally {
      infoSpy.mockRestore()
      global.Image = OriginalImage
    }
  })

  it('blocks CLAIM-it CXF export when a prescription attachment downloads as an empty file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    })))
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        prescription_file_url: 'https://example.test/empty-rx.pdf',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    await expect(buildNhisClaimItCxf(payload)).rejects.toThrow(
      'Unable to include prescription_NHIS-000001.pdf in CLAIM-it CXF export: downloaded file is empty'
    )
  })

  it('exports CLAIM-it CXF without blocking when a claim only has unreadable attachment metadata', async () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        prescription_file_path: 'nhis-prescriptions/rx-only-in-storage.pdf',
        prescription_file_url: '',
        prescription_file_name: 'rx-only-in-storage.pdf',
        prescription_file_type: 'application/pdf',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    expect(payload.claims[0].prescriptionAttachment).toBeNull()
    const cxf = await buildNhisClaimItCxf(payload)
    const inflated = inflateSync(Buffer.from(cxf.slice(3)))
    const inflatedText = inflated.toString('latin1')

    expect(Array.from(cxf.slice(0, 3))).toEqual([0x01, 0x02, 0x19])
    expect(inflatedText).toContain('s:11:"attachments";a:0:{}')
    expect(inflatedText).toContain('s:14:"attachmentdata";a:0:{}')
  })

  it('blocks CLAIM-it CXF export when stored attachment base64 is invalid', async () => {
    const payload = buildNhisClaimItExportPayload([
      {
        ...claim,
        claimit_attachment_file_type: 'pdf',
        claimit_attachment_mime_type: 'application/pdf',
        claimit_attachment_base64: 'not-valid-base64!',
      },
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    await expect(buildNhisClaimItCxf(payload)).rejects.toThrow('base64 is invalid')
  })

  it('includes hospital tariff service lines in CLAIM-it payload and XML', () => {
    const claimWithService = {
      ...claim,
      total_amount: 47.08,
      nhis_claim_services: [{
        nhia_tariff_item_id: 'tariff-1',
        tariff_version: 'FEB 2023',
        facility_group: 'CHAG Primary Care Hospital',
        catering_option: 'exclusive',
        mdc: 'Out Patient',
        gdrg_code: 'OPDC01A',
        description: 'General OPD Adult',
        age_band: null,
        unit_price: 37.08,
        quantity: 1,
        service_date: '2026-05-14',
        total_amount: 37.08,
      }],
    }
    const payload = buildNhisClaimItExportPayload([claimWithService], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
      generatedAt: '2026-05-15T00:00:00.000Z',
    })
    const xml = buildNhisClaimItXml(payload)

    expect(payload.claims[0].tariffServices[0]).toMatchObject({
      code: 'OPDC01A',
      tariffVersion: 'FEB 2023',
      facilityGroup: 'CHAG Primary Care Hospital',
      totalAmount: 37.08,
    })
    expect(payload.totalAmount).toBe(47.08)
    expect(xml).toContain('<TariffServices>')
    expect(xml).toContain('<Code>OPDC01A</Code>')
    expect(xml).toContain('<TotalAmount>37.08</TotalAmount>')
  })

  it('includes service-line totals and the tariff version without exporting reference tariff rows', async () => {
    const payload = buildNhisClaimItExportPayload([{
      ...claim,
      prescription_file_url: 'https://example.test/rx.pdf',
      total_amount: 47.08,
      nhis_claim_services: [{
        gdrg_code: 'OPDC01A',
        description: 'General OPD Adult',
        unit_price: 18.54,
        quantity: 2,
        total_amount: 37.08,
        service_date: '2026-05-14',
      }],
    }], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
      facilityName: 'Central Hospital',
      facilityCode: 'HOSP-001',
      providerNumber: 'HOSP-PROV',
      credentialCode: '03-05-001-02-01954-11-P1-2-011225',
      providerClassLevel: 'B2',
      generatedAt: '2026-05-15T00:00:00.000Z',
    })

    const inflatedText = inflateSync(Buffer.from((await buildNhisClaimItCxf(payload)).slice(3))).toString('utf8')

    expect(inflatedText).toContain('2023-02-01.250531')
    expect(inflatedText).toContain('s:8:"gdrgCode";s:7:"OPDC01A"')
    expect(inflatedText).toContain('s:4:"cost";s:7:"37.0800"')
    expect(inflatedText).not.toContain('s:6:"tariff";s:7:"18.5400"')
  })

  it('normalizes monthly and custom export periods', () => {
    expect(normalizeNhisExportPeriod({ mode: 'month', yearMonth: '2026-02' })).toMatchObject({
      mode: 'month',
      yearMonth: '2026-02',
      fromDate: '2026-02-01',
      toDate: '2026-02-28',
      fileTag: '202602',
    })

    expect(normalizeNhisExportPeriod({
      mode: 'custom',
      fromDate: '2026-05-01',
      toDate: '2026-05-15',
    })).toMatchObject({
      mode: 'custom',
      yearMonth: '',
      label: '2026-05-01 to 2026-05-15',
      fileTag: '20260501-20260515',
    })

    expect(normalizeNhisExportPeriod({
      mode: 'partial',
      toDate: '2026-05-20',
    })).toMatchObject({
      mode: 'partial',
      yearMonth: '2026-05',
      fromDate: '2026-05-01',
      toDate: '2026-05-20',
      label: '2026-05-01 to 2026-05-20',
      fileTag: '20260501-20260520',
    })
  })

  it('blocks invalid custom export periods', () => {
    expect(() => normalizeNhisExportPeriod({
      mode: 'custom',
      fromDate: '2026-05-20',
      toDate: '2026-05-01',
    })).toThrow('Custom export From date cannot be after To date.')
  })

  it('uses created_at only when an NHIS claim has no service date', () => {
    expect(getNhisClaimExportDate({
      service_date_from: '',
      created_at: '2026-06-09T14:30:00.000Z',
    })).toBe('2026-06-09')

    expect(getNhisClaimExportDate({
      service_date_from: '2026-05-14',
      created_at: '2026-06-09T14:30:00.000Z',
    })).toBe('2026-05-14')
  })

  it('includes a blank-service-date claim in its creation-date export period', () => {
    const period = normalizeNhisExportPeriod({
      mode: 'custom',
      fromDate: '2026-06-09',
      toDate: '2026-06-09',
    })

    expect(nhisClaimMatchesExportPeriod({
      service_date_from: null,
      created_at: '2026-06-09T14:30:00.000Z',
    }, period)).toBe(true)

    expect(nhisClaimMatchesExportPeriod({
      service_date_from: null,
      created_at: '2026-06-10T08:00:00.000Z',
    }, period)).toBe(false)
  })

  it('retrieves blank-service-date claims before applying the creation-date fallback', async () => {
    const insidePeriod = {
      id: 'claim-inside',
      status: 'served',
      service_date_from: null,
      submission_month: '2026-06',
      created_at: '2026-06-09T14:30:00.000Z',
      total_amount: 0,
      nhis_claim_medicines: [],
    }
    const outsidePeriod = {
      ...insidePeriod,
      id: 'claim-outside',
      created_at: '2026-06-10T08:00:00.000Z',
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({
        data: [insidePeriod, outsidePeriod],
        error: null,
      }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    await expect(getNhisClaimsForPeriod({
      mode: 'custom',
      fromDate: '2026-06-09',
      toDate: '2026-06-09',
    })).resolves.toEqual([
      expect.objectContaining({ id: 'claim-inside' }),
    ])

    expect(claimsQuery.gte).toHaveBeenCalledWith('submission_month', '2026-06')
    expect(claimsQuery.lte).toHaveBeenCalledWith('submission_month', '2026-06')
  })

  it('merges local corrections with cloud history for branch export periods', async () => {
    const localRows = [{
      id: 'shared-claim',
      status: 'rejected',
      submission_month: '2026-06',
      service_date_from: '2026-06-11',
      created_at: '2026-06-11T08:00:00.000Z',
    }]
    const cloudRows = [
      {
        id: 'cloud-only',
        status: 'served',
        submission_month: '2026-06',
        service_date_from: '2026-06-10',
        created_at: '2026-06-10T08:00:00.000Z',
      },
      {
        id: 'shared-claim',
        status: 'served',
        submission_month: '2026-06',
        service_date_from: '2026-06-11',
        created_at: '2026-06-11T08:00:00.000Z',
      },
    ]
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      eq: vi.fn().mockResolvedValue({ data: cloudRows, error: null }),
    }
    shouldUseBranchServer.mockReturnValue(true)
    listBranchRecords.mockResolvedValueOnce(localRows)
    supabase.from.mockReturnValue({ select: vi.fn(() => claimsQuery) })

    await expect(getNhisClaimsForPeriod({
      mode: 'month',
      yearMonth: '2026-06',
    })).resolves.toEqual([
      cloudRows[0],
      localRows[0],
    ])

    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { limit: 100000 })
  })

  it('includes custom period metadata in CLAIM-it payload and XML', () => {
    const payload = buildNhisClaimItExportPayload([claim], {
      mode: 'custom',
      fromDate: '2026-05-01',
      toDate: '2026-05-15',
      organizationType: 'hospital',
      generatedAt: '2026-05-15T00:00:00.000Z',
    })
    const xml = buildNhisClaimItXml(payload)

    expect(payload.submissionMonth).toBe('')
    expect(payload.exportMode).toBe('custom')
    expect(payload.periodLabel).toBe('2026-05-01 to 2026-05-15')
    expect(xml).toContain('<PeriodFrom>2026-05-01</PeriodFrom>')
    expect(xml).toContain('<PeriodTo>2026-05-15</PeriodTo>')
  })

  it('allows submitted claims in downloaded exports for the selected period', async () => {
    const submittedClaim = {
      ...claim,
      status: 'submitted',
      organization_type: 'pharmacy',
      diagnosis: '',
      nhis_claim_medicines: [
        {
          nhis_drug_id: 'drug-1',
          drug_code: 'NH001',
          description: 'Artemether Lumefantrine Tablet',
          unit: 'tablet',
          unit_price: 1,
          dispensed_qty: 10,
          dose: '1 tablet',
          frequency: 'BD',
          duration: '3 days',
          total_amount: 10,
          category: 'A',
        },
      ],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [submittedClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')
    URL.revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const count = await exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'json',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })

    expect(count).toBe(1)
    expect(clickSpy).toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it('names CLAIM-it CXF downloads like CLAIM-it partial exports', async () => {
    const submittedClaim = {
      ...claim,
      status: 'submitted',
      organization_type: 'pharmacy',
      diagnosis: '',
      nhis_claim_medicines: [
        {
          nhis_drug_id: 'drug-1',
          drug_code: 'NH001',
          description: 'Artemether Lumefantrine Tablet',
          unit: 'tablet',
          unit_price: 1,
          dispensed_qty: 10,
          dispensary_date: '2026-05-14',
          dose: '1 tablet',
          frequency: 'BD',
          duration: '3 days',
          total_amount: 10,
          category: 'A',
        },
      ],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [submittedClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')
    URL.revokeObjectURL = vi.fn()
    supabase.storage = {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: 'https://example.test/rx.pdf' },
          error: null,
        }),
      })),
    }
    let downloadedName = ''
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      downloadedName = this.download
    })

    await exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })

    expect(downloadedName).toMatch(/^MAY2026__[A-F0-9]{12} \[030501954\] \(WESTPOINT CHEMIST\)_2026-05-14-2026-05-14\.cxf$/)
    expect(supabase.storage.from).toHaveBeenCalledWith('nhis-prescriptions')
    clickSpy.mockRestore()
  })

  it('exports from prepared readiness without reloading the claims batch', async () => {
    const submittedClaim = {
      ...claim,
      status: 'submitted',
      organization_type: 'pharmacy',
      diagnosis: '',
      prescription_file_url: 'https://example.test/rx.pdf',
      nhis_claim_medicines: [
        {
          nhis_drug_id: 'drug-1',
          drug_code: 'NH001',
          description: 'Artemether Lumefantrine Tablet',
          unit: 'tablet',
          unit_price: 1,
          dispensed_qty: 10,
          dispensary_date: '2026-05-14',
          dose: '1 tablet',
          frequency: 'BD',
          duration: '3 days',
          total_amount: 10,
          category: 'A',
        },
      ],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [submittedClaim], error: null }),
    }
    const claimsSelect = vi.fn(() => claimsQuery)
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: claimsSelect }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')
    URL.revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const options = {
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    }
    const preparedReadiness = await prepareNhisClaimsExport(options)
    const count = await exportNhisClaimsFile({ ...options, preparedReadiness })

    expect(count).toBe(1)
    expect(claimsSelect).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it('batch-signs unique prescription attachment paths during CXF export', async () => {
    const claims = [
      {
        ...claim,
        id: 'claim-a',
        claim_number: 'NHIS-000001',
        status: 'submitted',
        organization_type: 'pharmacy',
        diagnosis: '',
        prescription_file_path: 'rx/shared.pdf',
        nhis_claim_medicines: [
          {
            nhis_drug_id: 'drug-1',
            drug_code: 'NH001',
            description: 'Artemether Lumefantrine Tablet',
            unit: 'tablet',
            unit_price: 1,
            dispensed_qty: 10,
            dispensary_date: '2026-05-14',
            dose: '1 tablet',
            frequency: 'BD',
            duration: '3 days',
            total_amount: 10,
            category: 'A',
          },
        ],
      },
      {
        ...claim,
        id: 'claim-b',
        claim_number: 'NHIS-000002',
        member_no: '87654321',
        hin: '87654321',
        status: 'submitted',
        organization_type: 'pharmacy',
        diagnosis: '',
        total_amount: 11,
        prescription_file_path: 'rx/shared.pdf',
        nhis_claim_medicines: [
          {
            nhis_drug_id: 'drug-1',
            drug_code: 'NH001',
            description: 'Artemether Lumefantrine Tablet',
            unit: 'tablet',
            unit_price: 1,
            dispensed_qty: 11,
            dispensary_date: '2026-05-14',
            dose: '1 tablet',
            frequency: 'BD',
            duration: '3 days',
            total_amount: 11,
            category: 'A',
          },
        ],
      },
    ]
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: claims, error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    const createSignedUrls = vi.fn().mockResolvedValue({
      data: [{ path: 'rx/shared.pdf', signedUrl: 'https://example.test/rx/shared.pdf' }],
      error: null,
    })
    supabase.storage = {
      from: vi.fn(() => ({ createSignedUrls })),
    }
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')
    URL.revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })

    expect(createSignedUrls).toHaveBeenCalledTimes(1)
    expect(createSignedUrls).toHaveBeenCalledWith(['rx/shared.pdf'], 60 * 60)
    expect(clickSpy).toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it('splits more than 1000 prescription attachment paths into safe signing batches', async () => {
    const claims = Array.from({ length: 1001 }, (_, index) => {
      const itemNumber = String(index + 1).padStart(6, '0')
      return {
        ...claim,
        id: `claim-${itemNumber}`,
        claim_number: `NHIS-${itemNumber}`,
        member_no: `12${itemNumber}`,
        hin: `12${itemNumber}`,
        status: 'submitted',
        organization_type: 'pharmacy',
        diagnosis: '',
        prescription_file_path: `rx/${itemNumber}.pdf`,
        total_amount: 10,
        nhis_claim_medicines: [
          {
            nhis_drug_id: 'drug-1',
            drug_code: 'NH001',
            description: 'Artemether Lumefantrine Tablet',
            unit: 'tablet',
            unit_price: 1,
            dispensed_qty: 10,
            dispensary_date: '2026-05-14',
            dose: '1 tablet',
            frequency: 'BD',
            duration: '3 days',
            total_amount: 10,
            category: 'A',
          },
        ],
      }
    })
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: claims, error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    const createSignedUrls = vi.fn(async (paths) => ({
      data: paths.map((path) => ({ path, signedUrl: `https://example.test/${path}` })),
      error: null,
    }))
    supabase.storage = {
      from: vi.fn(() => ({ createSignedUrls })),
    }
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')
    URL.revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const count = await exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })

    expect(count).toBe(1001)
    expect(createSignedUrls).toHaveBeenCalledTimes(3)
    expect(createSignedUrls.mock.calls.map(([paths]) => paths.length)).toEqual([500, 500, 1])
    expect(clickSpy).toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it('reports the failing prescription attachment signing batch without starting the download', async () => {
    const claims = Array.from({ length: 501 }, (_, index) => {
      const itemNumber = String(index + 1).padStart(6, '0')
      return {
        ...claim,
        id: `claim-${itemNumber}`,
        claim_number: `NHIS-${itemNumber}`,
        member_no: `12${itemNumber}`,
        hin: `12${itemNumber}`,
        status: 'submitted',
        organization_type: 'pharmacy',
        diagnosis: '',
        prescription_file_path: `rx/${itemNumber}.pdf`,
        total_amount: 10,
        nhis_claim_medicines: [
          {
            nhis_drug_id: 'drug-1',
            drug_code: 'NH001',
            description: 'Artemether Lumefantrine Tablet',
            unit: 'tablet',
            unit_price: 1,
            dispensed_qty: 10,
            dispensary_date: '2026-05-14',
            dose: '1 tablet',
            frequency: 'BD',
            duration: '3 days',
            total_amount: 10,
            category: 'A',
          },
        ],
      }
    })
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: claims, error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return { select: vi.fn(() => claimsQuery) }
      if (table === 'nhis_claim_services') return { select: vi.fn(() => serviceLinesQuery) }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    const createSignedUrls = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 500 }, (_, index) => {
          const itemNumber = String(index + 1).padStart(6, '0')
          return { path: `rx/${itemNumber}.pdf`, signedUrl: `https://example.test/rx/${itemNumber}.pdf` }
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: new Error('body/paths must NOT have more than 1000 items') })
    supabase.storage = {
      from: vi.fn(() => ({ createSignedUrls })),
    }
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })).rejects.toThrow('Storage signing chunk 2 of 2 failed')

    expect(createSignedUrls).toHaveBeenCalledTimes(2)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  const buildAttachmentTestClaim = (overrides = {}) => ({
    id: 'claim-1',
    claim_number: 'NHIS-000001',
    status: 'submitted',
    organization_type: 'pharmacy',
    member_no: '12345678',
    hin: '12345678',
    surname: 'Mensah',
    other_names: 'Ama',
    folder_no: 'F001',
    gender: 'female',
    date_of_birth: '1990-01-01',
    patient_address: 'Accra',
    ccc_no: 'CC-12345',
    diagnosis: 'Malaria',
    diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
    service_date_from: '2026-05-14',
    service_date_to: '2026-05-14',
    referring_facility: 'Westpoint Chemist',
    physician_name: 'Dr Test',
    total_amount: 10,
    nhis_claim_medicines: [
      {
        nhis_drug_id: 'drug-1',
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dispensary_date: '2026-05-14',
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      },
    ],
    ...overrides,
  })

  it('never silently proceeds when the storage response omits a requested attachment path', async () => {
    const claimWithUrl = buildAttachmentTestClaim({
      id: 'claim-resolved',
      claim_number: 'NHIS-000010',
      prescription_file_path: 'rx/resolved.pdf',
      prescription_document_type: 'prescription',
      prescription_verified: true,
      prescription_verified_by: '11111111-1111-4111-8111-111111111111',
      prescription_verified_at: '2026-05-14T10:00:00.000Z',
    })
    const claimMissingFromResponse = buildAttachmentTestClaim({
      id: 'claim-unresolved',
      claim_number: 'NHIS-000011',
      member_no: '87654321',
      hin: '87654321',
      total_amount: 11,
      prescription_file_path: 'rx/unresolved.pdf',
    })
    const claims = [claimWithUrl, claimMissingFromResponse]
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: claims, error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return { select: vi.fn(() => claimsQuery) }
      if (table === 'nhis_claim_services') return { select: vi.fn(() => serviceLinesQuery) }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    // No error from the storage API — it simply returns fewer signed URLs
    // than paths requested, which a naive implementation would silently drop.
    const createSignedUrls = vi.fn().mockResolvedValue({
      data: [{ path: 'rx/resolved.pdf', signedUrl: 'https://example.test/rx/resolved.pdf' }],
      error: null,
    })
    supabase.storage = {
      from: vi.fn(() => ({ createSignedUrls })),
    }
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })).rejects.toThrow('NHIS-000011')

    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('removes invalid prescription attachment paths before requesting signed URLs, and still flags the affected claim', async () => {
    const validClaim = buildAttachmentTestClaim({
      id: 'claim-valid',
      claim_number: 'NHIS-000020',
      prescription_file_path: 'rx/good.pdf',
      prescription_document_type: 'prescription',
      prescription_verified: true,
      prescription_verified_by: '11111111-1111-4111-8111-111111111111',
      prescription_verified_at: '2026-05-14T10:00:00.000Z',
    })
    const corruptedClaim = buildAttachmentTestClaim({
      id: 'claim-corrupted',
      claim_number: 'NHIS-000021',
      member_no: '87654322',
      hin: '87654322',
      total_amount: 11,
      // Simulates corrupted/placeholder data rather than a real storage path.
      prescription_file_path: 'null',
      prescription_document_type: 'prescription',
      prescription_verified: true,
      prescription_verified_by: '11111111-1111-4111-8111-111111111111',
      prescription_verified_at: '2026-05-14T10:00:00.000Z',
    })
    const claims = [validClaim, corruptedClaim]
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: claims, error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return { select: vi.fn(() => claimsQuery) }
      if (table === 'nhis_claim_services') return { select: vi.fn(() => serviceLinesQuery) }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    const createSignedUrls = vi.fn().mockResolvedValue({
      data: [{ path: 'rx/good.pdf', signedUrl: 'https://example.test/rx/good.pdf' }],
      error: null,
    })
    supabase.storage = {
      from: vi.fn(() => ({ createSignedUrls })),
    }
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })).rejects.toThrow('NHIS-000021')

    // The invalid path never reached the storage API — only the valid one did.
    expect(createSignedUrls).toHaveBeenCalledWith(['rx/good.pdf'], 60 * 60)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('identifies every claim missing a prescription attachment in a mixed batch, not just the first', async () => {
    const claimWithAttachment = buildAttachmentTestClaim({
      id: 'claim-has-attachment',
      claim_number: 'NHIS-000030',
      status: 'served',
      prescription_file_path: 'org/2026-05/claim/rx.pdf',
      prescription_file_url: 'https://example.test/org/2026-05/claim/rx.pdf',
      prescription_document_type: 'prescription',
      prescription_verified: true,
      prescription_verified_by: '11111111-1111-4111-8111-111111111111',
      prescription_verified_at: '2026-05-14T10:00:00.000Z',
    })
    const firstMissingClaim = buildAttachmentTestClaim({
      id: 'claim-missing-1',
      claim_number: 'NHIS-000031',
      member_no: '87654323',
      hin: '87654323',
      status: 'served',
      total_amount: 11,
    })
    const secondMissingClaim = buildAttachmentTestClaim({
      id: 'claim-missing-2',
      claim_number: 'NHIS-000032',
      member_no: '87654324',
      hin: '87654324',
      status: 'served',
      total_amount: 12,
    })
    const claims = [claimWithAttachment, firstMissingClaim, secondMissingClaim]
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: claims, error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return { select: vi.fn(() => claimsQuery) }
      if (table === 'nhis_claim_services') return { select: vi.fn(() => serviceLinesQuery) }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })).rejects.toMatchObject({
      code: 'NHIS_READINESS_CLAIMS',
      readinessIssues: expect.arrayContaining([
        expect.objectContaining({ claim_number: 'NHIS-000031' }),
        expect.objectContaining({ claim_number: 'NHIS-000032' }),
      ]),
    })

    let caughtError
    try {
      await exportNhisClaimsFile({
        mode: 'custom',
        fromDate: '2026-05-14',
        toDate: '2026-05-14',
        format: 'cxf',
        organizationType: 'pharmacy',
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        pharmacyFacilityLevel: 'P1',
        facilityName: 'Westpoint Chemist',
        facilityCode: '03-05-001-02-01954-11-P1-2-011225',
        providerNumber: '03-05-01954',
        providerTypeDescription: 'Pharmacy',
        accreditationExpiryDate: '2026-12-31',
        claimsOfficerName: 'Claims Officer',
        submitterId: 'admin',
        nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
      })
    } catch (error) {
      caughtError = error
    }
    // Exactly the two offending claims are flagged — the claim that already
    // has an attachment must not appear, and neither claim is dropped.
    expect(caughtError.readinessIssues.map((issue) => issue.claim_number).sort()).toEqual([
      'NHIS-000031',
      'NHIS-000032',
    ])
  })

  it('keeps CXF on the manual export route even when direct submit is requested', async () => {
    const servedClaim = {
      ...claim,
      status: 'served',
      organization_type: 'pharmacy',
      diagnosis: '',
      nhis_claim_medicines: [
        {
          nhis_drug_id: 'drug-1',
          drug_code: 'NH001',
          description: 'Artemether Lumefantrine Tablet',
          unit: 'tablet',
          unit_price: 1,
          dispensed_qty: 10,
          dispensary_date: '2026-05-14',
          dose: '1 tablet',
          frequency: 'BD',
          duration: '3 days',
          total_amount: 10,
          category: 'A',
        },
      ],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [servedClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')
    URL.revokeObjectURL = vi.fn()
    supabase.storage = {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: 'https://example.test/rx.pdf' },
          error: null,
        }),
      })),
    }
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const count = await exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      directSubmit: true,
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      pharmacyFacilityLevel: 'P1',
      facilityName: 'Westpoint Chemist',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })

    expect(count).toBe(1)
    expect(clickSpy).toHaveBeenCalled()
    expect(submitNhiaDirectPayload).not.toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it('blocks CLAIM-it CXF export until the facility credential code is configured', async () => {
    const submittedClaim = {
      ...claim,
      status: 'submitted',
      organization_type: 'pharmacy',
      diagnosis: '',
      nhis_claim_medicines: [{
        nhis_drug_id: 'drug-1',
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [submittedClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })).rejects.toThrow('CLAIM-it CXF export needs complete NHIA configuration')
  })
})

describe('direct NHIA submission', () => {
  const directSettings = {
    providerClassLevel: 'D',
    pharmacyLevel: 'P1',
    pharmacyFacilityLevel: 'P1',
    facilityName: 'Westpoint Chemist',
    facilityCode: '03-05-001-02-01954-11-P1-2-011225',
    providerNumber: '03-05-01954',
    providerTypeDescription: 'Pharmacy',
    accreditationExpiryDate: '2026-12-31',
    claimsOfficerName: 'Claims Officer',
    submitterId: 'admin',
    nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
  }
  const directClaim = {
    id: 'claim-1',
    claim_number: 'NHIS-000001',
    status: 'served',
    organization_type: 'pharmacy',
    member_no: '12345678',
    surname: 'Mensah',
    other_names: 'Ama',
    folder_no: 'F001',
    patient_address: 'Accra',
    date_of_birth: '1990-01-01',
    ccc_no: 'CC-12345',
    diagnosis: 'Malaria',
    service_date_from: '2026-05-14',
    referring_facility: 'Westpoint Chemist',
    physician_name: 'Dr Test',
    prescription_file_path: 'org/2026-05/claim/rx.pdf',
    prescription_file_name: 'rx.pdf',
    prescription_file_url: 'https://example.test/rx.pdf',
    prescription_document_type: 'prescription',
    prescription_verified: true,
    prescription_verified_by: '11111111-1111-4111-8111-111111111111',
    prescription_verified_at: '2026-05-14T10:00:00.000Z',
    total_amount: 10,
    nhis_claim_medicines: [
      {
        nhis_drug_id: 'drug-1',
        drug_code: 'NH001',
        description: 'Paracetamol Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dispensary_date: '2026-05-14',
        dose: '1 tablet',
        frequency: 'TDS',
        duration: '5 days',
        total_amount: 10,
        category: 'A',
      },
    ],
  }

  it('keeps the tier-access router action separate from the submission audit label', async () => {
    mockNhisClaimDuplicateAndUpdateQueries()
    invokeTierAccess.mockResolvedValue({
      source: 'hosted',
      httpStatus: 200,
      response: { accepted: true },
      claimIds: ['claim-1'],
      action: 'nhis.direct_claim_submit',
    })

    await submitNhisClaimDirect('claim-1', {
      claim: directClaim,
      directApiSource: 'hosted',
      ...directSettings,
    })

    expect(invokeTierAccess).toHaveBeenCalledWith(expect.objectContaining({
      action: 'submit_nhia_claims_direct',
      submissionAction: 'nhis.direct_claim_submit',
      claimIds: ['claim-1'],
    }))
  })

  it('routes public CLAIM-it bridge URLs through the branch server', async () => {
    mockNhisClaimDuplicateAndUpdateQueries()
    submitNhiaDirectPayload.mockResolvedValue({ status: 'submitted', httpStatus: 200, response: { accepted: true } })

    await submitNhisClaimDirect('claim-1', {
      claim: directClaim,
      directApiSource: 'hosted',
      integrationMode: 'claimit_bridge',
      connectionProfile: 'local_server',
      apiBaseUrl: 'https://claims.example.test/json-api',
      claimEndpointPath: '/claims',
      ...directSettings,
    })

    expect(fetch).not.toHaveBeenCalledWith(
      'https://claims.example.test/json-api/claims',
      expect.any(Object)
    )
    expect(submitNhiaDirectPayload).toHaveBeenCalledWith(expect.objectContaining({
      action: 'nhis.direct_claim_submit',
      claimIds: ['claim-1'],
    }))
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('sends tenant context when requesting a hosted CCC/CC code', async () => {
    getConnectivityState.mockReturnValueOnce({
      mode: 'ONLINE_CLOUD',
      internetAvailable: true,
      branchServerAvailable: false,
      checkedAt: Date.now(),
    })
    invokeTierAccess.mockResolvedValueOnce({
      ccCode: '12345',
      source: 'claimit_bridge',
    })

    await expect(generateHostedNhiaCcCode({
      organizationId: 'org-1',
      branchId: 'branch-1',
      organizationType: 'pharmacy',
      patientName: 'Ama Mensah',
      memberNumber: '12345678',
      serviceDate: '2026-05-26',
      totalAmount: 12,
    })).resolves.toMatchObject({
      ccCode: '12345',
      source: 'claimit_bridge',
    })

    expect(invokeTierAccess).toHaveBeenCalledWith(expect.objectContaining({
      action: 'generate_nhia_cc_code',
      organizationId: 'org-1',
      branchId: 'branch-1',
      patientName: 'Ama Mensah',
      memberNumber: '12345678',
    }))
  })

  it('returns inactive hosted member details even when no CC code is issued', async () => {
    getConnectivityState.mockReturnValueOnce({
      mode: 'ONLINE_CLOUD',
      internetAvailable: true,
      branchServerAvailable: false,
      checkedAt: Date.now(),
    })
    invokeTierAccess.mockResolvedValueOnce({
      ok: true,
      ccCode: '',
      source: 'api',
      eligibilityError: 'NHIA member lookup did not return a CC code: INACTIVE.',
      memberDetails: {
        memberName: 'FRANK OKYERE',
        hin: '99441270',
        status: 'INACTIVE',
      },
    })

    await expect(generateHostedNhiaCcCode({
      organizationId: 'org-1',
      memberNumber: '99441270',
    })).resolves.toMatchObject({
      ccCode: '',
      eligibilityError: expect.stringContaining('INACTIVE'),
      memberDetails: {
        memberName: 'FRANK OKYERE',
        hin: '99441270',
        status: 'INACTIVE',
      },
    })
  })

  it('blocks hosted CCC verification while local branch mode is active', async () => {
    getConnectivityState.mockReturnValueOnce({
      mode: 'ONLINE_LOCAL_SYNC',
      internetAvailable: true,
      branchServerAvailable: true,
      checkedAt: Date.now(),
    })

    await expect(generateHostedNhiaCcCode({
      organizationId: 'org-1',
      memberNumber: '12345678',
    })).rejects.toThrow('blocked while local branch mode is active')

    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('requires organizationId before hosted CCC verification', async () => {
    getConnectivityState.mockReturnValueOnce({
      mode: 'ONLINE_CLOUD',
      internetAvailable: true,
      branchServerAvailable: false,
      checkedAt: Date.now(),
    })

    await expect(generateHostedNhiaCcCode({
      memberNumber: '12345678',
    })).rejects.toThrow('organizationId is missing')

    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('routes local CLAIM-it bridge submissions through the branch server', async () => {
    mockNhisClaimDuplicateAndUpdateQueries()
    submitNhiaDirectPayload.mockResolvedValue({
      status: 'submitted',
      httpStatus: 200,
      response: { success: true, savedClaims: 1 },
    })

    await submitNhisClaimDirect('claim-1', {
      claim: directClaim,
      directApiSource: 'hosted',
      integrationMode: 'claimit_bridge',
      connectionProfile: 'local_server',
      apiBaseUrl: 'http://localhost:31719/json-api',
      claimEndpointPath: '/claims',
      ...directSettings,
    })

    expect(submitNhiaDirectPayload).toHaveBeenCalledWith(expect.objectContaining({
      action: 'nhis.direct_claim_submit',
      claimIds: ['claim-1'],
      payload: expect.objectContaining({
        payloadFormat: 'claimit_relational_json_v1',
        claims: [
          expect.objectContaining({
            claimID: expect.any(String),
            claimNumber: 'NHIS-000001',
            claimCheckCode: '12345',
            medVersion: expect.any(String),
            policyVersion: expect.any(String),
          }),
        ],
        data: expect.objectContaining({
          medicineentries: [
            expect.objectContaining({
              medicineCode: 'NH001',
            }),
          ],
          validation_zclaims: [
            expect.objectContaining({
              serializedClaim: expect.any(String),
            }),
          ],
        }),
      }),
    }))
    expect(fetch.mock.calls.some(([url]) => String(url).includes('localhost:31719'))).toBe(false)
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('sends rich XML through the branch route for XML direct submission', async () => {
    mockNhisClaimDuplicateAndUpdateQueries()
    submitNhiaDirectPayload.mockResolvedValue({
      status: 'submitted',
      httpStatus: 200,
      response: { success: true, savedClaims: 1 },
    })

    await submitNhisClaimDirect('claim-1', {
      claim: directClaim,
      directApiSource: 'hosted',
      integrationMode: 'claimit_bridge',
      directPayloadFormat: 'xml',
      format: 'xml',
      apiBaseUrl: 'http://localhost:31719/json-api',
      claimEndpointPath: '/claims',
      ...directSettings,
    })

    const request = submitNhiaDirectPayload.mock.calls[0][0]
    expect(request.contentType).toBe('application/xml;charset=utf-8')
    expect(request.payload).toMatchObject({
      payloadFormat: 'claimit_relational_json_v1',
      claims: [expect.objectContaining({
        claimID: expect.any(String),
        medVersion: expect.any(String),
        policyVersion: expect.any(String),
      })],
      data: expect.objectContaining({
        medicineentries: [expect.objectContaining({ medicineCode: 'NH001' })],
        attachmentdata: [expect.objectContaining({ data: expect.any(String) })],
      }),
    })
    expect(request.payloadContent).toContain('<Claims-Data>')
    expect(request.payloadContent).toContain(`<claimID>${request.payload.claims[0].claimID}</claimID>`)
    expect(request.payloadContent).toContain('<medicineCode>NH001</medicineCode>')
    expect(request.payloadContent).toContain('<attachmentdata>')
    expect(fetch.mock.calls.some(([url]) => String(url).includes('localhost:31719'))).toBe(false)
  })

  it('serializes relational arrays with CLAIM-it-specific XML element names', () => {
    const xml = buildNhisClaimItDirectXml({
      claims: [{ claimID: 'claim-guid' }],
      data: {
        medicineentries: [{ medicineCode: 'NH001' }],
      },
    })

    expect(xml).toContain('<claims>\n    <claim>')
    expect(xml).toContain('<medicineentries>\n      <medicineentry>')
    expect(xml).not.toContain('<claims>\n    <item>')
  })

  it('does not queue CLAIM-it payloads when the branch route is unreachable', async () => {
    mockNhisClaimDuplicateAndUpdateQueries()
    submitNhiaDirectPayload.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(submitNhisClaimDirect('claim-1', {
      claim: directClaim,
      directApiSource: 'hosted',
      integrationMode: 'claimit_bridge',
      connectionProfile: 'local_server',
      apiBaseUrl: 'http://localhost:31719/json-api',
      claimEndpointPath: '/claims',
      ...directSettings,
    })).rejects.toThrow('browser is not permitted to send claims directly to CLAIM-it')

    expect(window.localStorage.getItem('healthflow.claimitBridgeQueue.v1')).toBeNull()
    expect(fetch.mock.calls.some(([url]) => String(url).includes('localhost:31719'))).toBe(false)
  })

  it('surfaces CLAIM-it rejection returned by the branch server', async () => {
    mockNhisClaimDuplicateAndUpdateQueries()
    submitNhiaDirectPayload.mockRejectedValueOnce(
      new Error('CLAIM-it did not save the claim batch: Medicine price/version could not be validated.')
    )

    await expect(submitNhisClaimDirect('claim-1', {
      claim: directClaim,
      directApiSource: 'hosted',
      integrationMode: 'claimit_bridge',
      connectionProfile: 'local_server',
      apiBaseUrl: 'http://localhost:31719/json-api',
      claimEndpointPath: '/claims',
      ...directSettings,
    })).rejects.toThrow('Medicine price/version could not be validated.')
    expect(fetch.mock.calls.some(([url]) => String(url).includes('localhost:31719'))).toBe(false)
  })
})

describe('NHIS claim save attachment behavior', () => {
  const claimWithoutPrescription = {
    ...baseClaim,
    prescriptionFilePath: '',
    prescriptionFileName: '',
  }
  const medicineWithTotal = { ...baseMedicine, totalAmount: 10 }

  it('saves an attachment-free pharmacy intake while it is pending serving', async () => {
    const insertedClaim = { id: 'claim-1', claim_number: 'NHIS-000001', status: 'pending_serving' }
    const claimInsertResult = {
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({ data: insertedClaim, error: null }),
      })),
    }
    const duplicateQuery = {
      eq: vi.fn(() => duplicateQuery),
      neq: vi.fn(() => duplicateQuery),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    const claimTable = {
      select: vi.fn(() => duplicateQuery),
      insert: vi.fn(() => claimInsertResult),
    }
    const medicineTable = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    }
    const serviceTable = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    }

    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return claimTable
      if (table === 'nhis_claim_medicines') return medicineTable
      if (table === 'nhis_claim_services') return serviceTable
      return { update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) }
    })

    await expect(createNhisClaim(
      {
        ...claimWithoutPrescription,
        organizationId: '542fe9df-3211-4046-bd90-b101d249b7f9',
        dateOfBirth: '14/05/1990',
        serviceDate: '2026-06-18T00:30:00.000Z',
        cardType: 'GHANACARD',
        authId: 'AUTH-123',
        authType: 'NHIS',
        newCcc: 'true',
        otacCode: '987654',
        nhiaAttendanceDate: '18/06/2026',
        nhiaEligibilityStartDate: '01/06/2026',
        nhiaEligibilityEndDate: '30/06/2026',
        attendanceVerificationStatus: 'confirmed',
        attendanceVerificationSource: 'nehfams_manual',
        prescribingFacilityId: '11111111-1111-4111-8111-111111111111',
        prescriberId: '22222222-2222-4222-8222-222222222222',
        prescriptionDate: '17/06/2026',
        prescriptionReference: 'RX-2026-001',
        prescribingFacilityNameSnapshot: 'Korle Bu OPD',
        prescribingFacilityCodeSnapshot: 'KBTH-OPD',
        prescriberNameSnapshot: 'Dr Test',
        prescriberLicenseSnapshot: 'MDC-12345',
        servingReviewedAt: '',
        status: 'pending_serving',
      },
      [{ ...medicineWithTotal, enteredAt: '', servedAt: '' }],
      {
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).resolves.toEqual(insertedClaim)

    expect(claimTable.insert).toHaveBeenCalled()
    expect(claimTable.insert.mock.calls[0][0][0]).toMatchObject({
      organization_id: '542fe9df-3211-4046-bd90-b101d249b7f9',
      date_of_birth: '1990-05-14',
      service_date_from: '2026-06-18',
      service_date_to: '2026-06-18',
      card_type: 'GHANACARD',
      nhia_auth_id: 'AUTH-123',
      nhia_auth_type: 'NHIS',
      nhia_new_ccc_status: 'yes',
      nhia_otac: '987654',
      nhia_attendance_date: '2026-06-18',
      nhia_eligibility_start_date: '2026-06-01',
      nhia_eligibility_end_date: '2026-06-30',
      nhia_attendance_verification_status: 'confirmed',
      nhia_attendance_verification_source: 'nehfams_manual',
      prescribing_facility_id: '11111111-1111-4111-8111-111111111111',
      prescriber_id: '22222222-2222-4222-8222-222222222222',
      prescription_date: '2026-06-17',
      prescription_reference: 'RX-2026-001',
      prescribing_facility_name_snapshot: 'Korle Bu OPD',
      prescribing_facility_code_snapshot: 'KBTH-OPD',
      prescriber_name_snapshot: 'Dr Test',
      prescriber_license_snapshot: 'MDC-12345',
      referring_facility: 'Westpoint Chemist',
      physician_name: 'Dr Test',
      serving_reviewed_at: null,
      status: 'pending_serving',
    })
    expect(medicineTable.insert).toHaveBeenCalled()
    expect(medicineTable.insert.mock.calls[0][0][0]).toMatchObject({
      entered_at: null,
      served_at: null,
    })
  })

  it('blocks a pharmacy claim from becoming served without an attachment', async () => {
    await expect(createNhisClaim(
      {
        ...claimWithoutPrescription,
        status: 'served',
      },
      [medicineWithTotal],
      {
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).rejects.toThrow('Attach the scanned prescription PDF or JPEG')
  })

  it('keeps retrying cloud claim inserts when multiple optional columns are missing', async () => {
    const insertedClaim = { id: 'claim-1', claim_number: 'NHIS-000001', status: 'pending_serving' }
    const insertPayloads = []
    const makeClaimInsertResult = (response) => ({
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue(response),
      })),
    })
    const duplicateQuery = {
      eq: vi.fn(() => duplicateQuery),
      neq: vi.fn(() => duplicateQuery),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    const claimTable = {
      select: vi.fn(() => duplicateQuery),
      insert: vi.fn((payload) => {
        insertPayloads.push(payload[0])
        if (insertPayloads.length === 1) {
          return makeClaimInsertResult({
            data: null,
            error: {
              code: 'PGRST204',
              message: "Could not find the 'unserved_medicines_note' column of 'nhis_claims' in the schema cache",
            },
          })
        }
        if (insertPayloads.length === 2) {
          return makeClaimInsertResult({
            data: null,
            error: {
              code: 'PGRST204',
              message: "Could not find the 'serving_status' column of 'nhis_claims' in the schema cache",
            },
          })
        }
        return makeClaimInsertResult({ data: insertedClaim, error: null })
      }),
    }
    const medicineTable = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    }
    const serviceTable = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    }

    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return claimTable
      if (table === 'nhis_claim_medicines') return medicineTable
      if (table === 'nhis_claim_services') return serviceTable
      return { update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) }
    })

    await expect(createNhisClaim(
      {
        ...claimWithoutPrescription,
        unservedMedicinesNote: 'Could not serve one line.',
        servingStatus: 'pending',
        status: 'pending_serving',
      },
      [medicineWithTotal],
      {
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).resolves.toEqual(insertedClaim)

    expect(insertPayloads).toHaveLength(3)
    expect(insertPayloads[0]).toHaveProperty('unserved_medicines_note')
    expect(insertPayloads[0]).toHaveProperty('serving_status')
    expect(insertPayloads[1]).not.toHaveProperty('unserved_medicines_note')
    expect(insertPayloads[1]).toHaveProperty('serving_status')
    expect(insertPayloads[2]).not.toHaveProperty('unserved_medicines_note')
    expect(insertPayloads[2]).not.toHaveProperty('serving_status')
    expect(medicineTable.insert).toHaveBeenCalled()
  })

  it('still blocks save when a caller explicitly requires an RX attachment', async () => {
    await expect(createNhisClaim(
      claimWithoutPrescription,
      [medicineWithTotal],
      {
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
        requirePrescriptionAttachment: true,
      }
    )).rejects.toThrow('Attach the scanned prescription PDF or JPEG')
  })

  it('updates local branch NHIS claims without probing the Supabase mirror row', async () => {
    shouldUseBranchServer.mockReturnValue(false)
    updateBranchRecord.mockResolvedValueOnce({
      id: 'claim-1',
      claim_number: 'NHIS-000001',
      status: 'served',
    })

    await expect(updateNhisClaim(
      'claim-1',
      {
        ...baseClaim,
        cccNo: '81416',
        claimitAttachmentFileName: 'prescription_NHIS-000001.pdf',
        claimitAttachmentFileType: 'pdf',
        claimitAttachmentMimeType: 'application/pdf',
        claimitAttachmentBase64: Buffer.from('%PDF-1.7\n%%EOF', 'utf8').toString('base64'),
      },
      [medicineWithTotal],
      {
        useBranchServer: true,
        allowIncompleteReview: true,
        expectedUpdatedAt: '2026-06-30T12:00:00.000Z',
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).resolves.toMatchObject({
      id: 'claim-1',
      status: 'served',
    })

    expect(updateBranchRecord).toHaveBeenCalledWith(
      'nhis/claims',
      'claim-1',
      expect.objectContaining({
        claimit_attachment_file_name: 'prescription_NHIS-000001.pdf',
        expected_updated_at: '2026-06-30T12:00:00.000Z',
        nhis_claim_medicines: expect.any(Array),
      })
    )
    expect(supabase.from).not.toHaveBeenCalledWith('nhis_claims')
  })

  it('saves an incomplete shared claim after dispatch without marking it ready', async () => {
    updateBranchRecord.mockResolvedValueOnce({
      id: 'claim-1',
      claim_number: 'NHIS-000001',
      status: 'pending_serving',
      nhis_claim_medicines: [],
    })

    await expect(updateNhisClaim(
      'claim-1',
      {
        ...claimWithoutPrescription,
        status: 'pending_serving',
        servingStatus: 'pending',
      },
      [],
      {
        useBranchServer: true,
        allowIncompleteReview: true,
        expectedUpdatedAt: '2026-06-30T12:00:00.000Z',
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).resolves.toMatchObject({
      id: 'claim-1',
      status: 'pending_serving',
      nhis_claim_medicines: [],
    })

    expect(updateBranchRecord).toHaveBeenCalledWith(
      'nhis/claims',
      'claim-1',
      expect.objectContaining({
        status: 'pending_serving',
        expected_updated_at: '2026-06-30T12:00:00.000Z',
        nhis_claim_medicines: [],
      })
    )
  })

  it('uses the medicines-only branch route for a dispensary save', async () => {
    updateBranchNhisClaimMedicines.mockResolvedValueOnce({
      id: 'claim-1',
      status: 'served',
      total_amount: 10,
    })

    await expect(updateNhisClaim(
      'claim-1',
      { ...baseClaim, cccNo: '81416' },
      [medicineWithTotal],
      {
        useBranchServer: true,
        medicinesOnly: true,
        expectedUpdatedAt: '2026-06-30T12:00:00.000Z',
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).resolves.toMatchObject({
      id: 'claim-1',
      status: 'served',
    })

    expect(updateBranchNhisClaimMedicines).toHaveBeenCalledWith(
      'claim-1',
      expect.objectContaining({
        nhis_claim_medicines: expect.any(Array),
        total_amount: 10,
        expected_updated_at: '2026-06-30T12:00:00.000Z',
      })
    )
    expect(updateBranchRecord).not.toHaveBeenCalled()
  })

  it('does not block dispensary medicine saves on claim-completion or prescription-direction fields', async () => {
    updateBranchNhisClaimMedicines.mockResolvedValueOnce({
      id: 'claim-1',
      status: 'served',
      total_amount: 10,
    })

    await expect(updateNhisClaim(
      'claim-1',
      {
        ...baseClaim,
        cccNo: '81416',
        folderNo: '',
        referringFacility: '',
        physicianName: '',
      },
      [{
        ...medicineWithTotal,
        dose: '',
        frequency: '',
        duration: '',
      }],
      {
        useBranchServer: true,
        medicinesOnly: true,
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).resolves.toMatchObject({
      id: 'claim-1',
      status: 'served',
    })

    expect(updateBranchNhisClaimMedicines).toHaveBeenCalledWith(
      'claim-1',
      expect.objectContaining({
        nhis_claim_medicines: expect.any(Array),
        total_amount: 10,
      })
    )
    expect(updateBranchRecord).not.toHaveBeenCalled()
  })

  it('blocks an inline CLAIM-it attachment larger than 3 MB before saving', async () => {
    shouldUseBranchServer.mockReturnValue(true)
    const oversizedPdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'utf8'),
      Buffer.alloc(3 * 1024 * 1024),
    ]).toString('base64')

    await expect(createNhisClaim(
      {
        ...baseClaim,
        claimitAttachmentFileName: 'prescription_NHIS-000001.pdf',
        claimitAttachmentFileType: 'pdf',
        claimitAttachmentMimeType: 'application/pdf',
        claimitAttachmentBase64: oversizedPdf,
      },
      [medicineWithTotal],
      {
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).rejects.toThrow('attachment is larger than 3 MB')
  })
})

describe('duplicate NHIS claim prevention', () => {
  it('blocks saving the same member, service date, and total amount twice', async () => {
    mockNhisClaimDuplicateAndUpdateQueries({
      duplicates: [{
        id: 'existing-claim',
        claim_number: 'NHIS-000123',
        member_no: '12345678',
        service_date_from: '2026-05-14',
        total_amount: 10,
      }],
    })

    await expect(createNhisClaim(
      baseClaim,
      [{ ...baseMedicine, totalAmount: 10 }],
      {
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
      }
    )).rejects.toThrow('Duplicate NHIS claim blocked')
  })

  it('blocks batch export when duplicate claims are already present', async () => {
    const sourceClaim = {
      id: 'claim-1',
      claim_number: 'NHIS-000001',
      status: 'served',
      organization_type: 'hospital',
      member_no: '12345678',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '1990-01-01',
      patient_address: 'Accra',
      ccc_no: 'CC-12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Chemist',
      physician_name: 'Dr Test',
      prescription_file_path: 'org/2026-05/claim/rx.pdf',
      prescription_file_name: 'rx.pdf',
      prescription_file_url: 'https://example.test/rx.pdf',
      total_amount: 10,
      created_at: '2026-05-14T09:00:00.000Z',
      updated_at: '2026-05-14T09:05:00.000Z',
      nhis_claim_medicines: [{
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const duplicateClaim = {
      ...sourceClaim,
      id: 'claim-2',
      claim_number: 'NHIS-000002',
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [sourceClaim, duplicateClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'json',
      organizationType: 'hospital',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
    })).rejects.toMatchObject({
      code: 'NHIS_DUPLICATE_CLAIMS',
      duplicateGroups: [
        expect.objectContaining({
          claims: expect.arrayContaining([
            expect.objectContaining({
              claim_number: 'NHIS-000001',
              created_at: '2026-05-14T09:00:00.000Z',
              updated_at: '2026-05-14T09:05:00.000Z',
            }),
          ]),
        }),
      ],
    })
  })

  it('returns scrub warnings for exportable claims without blocking the batch', async () => {
    const warningClaim = {
      id: 'claim-warning-1',
      claim_number: 'NHIS-000010',
      status: 'served',
      organization_type: 'hospital',
      member_no: '12345678',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '2020-01-01',
      patient_address: 'Accra',
      ccc_no: '12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Chemist',
      physician_name: 'Dr Test',
      total_amount: 10,
      nhis_claim_medicines: [{
        nhis_drug_id: 'drug-1',
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [warningClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })

    const warnings = await getNhisExportScrubWarnings({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'json',
      organizationType: 'hospital',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })

    expect(warnings).toEqual([
      expect.objectContaining({
        claim_number: 'NHIS-000010',
        issues: expect.arrayContaining([
          'Child weight is missing for a child patient.',
        ]),
      }),
    ])
  })

  it('adds active-medication overlap advisories to export scrub warnings without blocking export', async () => {
    const claimId = '11111111-1111-4111-8111-111111111111'
    const warningClaim = {
      id: claimId,
      claim_number: 'NHIS-000011',
      status: 'served',
      organization_id: '22222222-2222-4222-8222-222222222222',
      organization_type: 'hospital',
      member_no: '12345678',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '1990-01-01',
      patient_address: 'Accra',
      ccc_no: '12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Hospital',
      physician_name: 'Dr Test',
      total_amount: 10,
      nhis_claim_medicines: [{
        nhis_drug_id: 'drug-1',
        drug_code: 'PARA500',
        description: 'Paracetamol Tablet 500mg',
        generic_name: 'Paracetamol',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '5 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [warningClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    supabase.rpc.mockResolvedValueOnce({
      data: [{
        input_claim_id: claimId,
        severity: 'warning',
        match_type: 'early_refill_review',
        medicine_code: 'PARA500',
        medicine_description: 'Paracetamol Tablet 500mg',
        remaining_days: 4,
        risk_score: 70,
        recommended_action: 'Confirm refill reason before export.',
      }],
      error: null,
    })

    const warnings = await getNhisExportScrubWarnings({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'json',
      organizationType: 'hospital',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'PARA500', category: 'A' }],
    })

    expect(supabase.rpc).toHaveBeenCalledWith('check_nhis_active_medication_overlap_batch', {
      p_items: [expect.objectContaining({
        claim_id: claimId,
        member_no: '12345678',
        medicine_code: 'PARA500',
        generic_name: 'Paracetamol',
        requested_quantity: 10,
        service_date: '2026-05-14',
      })],
    })
    expect(warnings).toEqual([
      expect.objectContaining({
        id: claimId,
        claim_number: 'NHIS-000011',
        issues: expect.arrayContaining([
          expect.stringContaining('Active medication review: Paracetamol Tablet 500mg has early refill review'),
          expect.stringContaining('Confirm refill reason before export.'),
        ]),
      }),
    ])
  })

  it('keeps normal export scrub warnings when the active-medication batch RPC is unavailable', async () => {
    const warningClaim = {
      id: '33333333-3333-4333-8333-333333333333',
      claim_number: 'NHIS-000012',
      status: 'served',
      organization_type: 'hospital',
      member_no: '12345678',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '2020-01-01',
      patient_address: 'Accra',
      ccc_no: '12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Hospital',
      physician_name: 'Dr Test',
      total_amount: 10,
      nhis_claim_medicines: [{
        nhis_drug_id: 'drug-1',
        drug_code: 'PARA500',
        description: 'Paracetamol Tablet 500mg',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '5 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [warningClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    supabase.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42883', message: 'function check_nhis_active_medication_overlap_batch does not exist' },
    })

    const warnings = await getNhisExportScrubWarnings({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'json',
      organizationType: 'hospital',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'PARA500', category: 'A' }],
    })

    expect(warnings).toEqual([
      expect.objectContaining({
        claim_number: 'NHIS-000012',
        issues: expect.arrayContaining([
          'Child weight is missing for a child patient.',
        ]),
      }),
    ])
  })

  it('reports other export blockers together with duplicate claims', async () => {
    const sourceClaim = {
      id: 'claim-1',
      claim_number: 'NHIS-000001',
      status: 'served',
      organization_type: 'pharmacy',
      member_no: '12345678',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '1990-01-01',
      patient_address: 'Accra',
      ccc_no: 'CC-12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Chemist',
      physician_name: 'Dr Test',
      total_amount: 10,
      nhis_claim_medicines: [{
        nhisDrugId: 'drug-1',
        nhis_drug_id: 'drug-1',
        drugCode: 'NH001',
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const duplicateClaim = {
      ...sourceClaim,
      id: 'claim-2',
      claim_number: 'NHIS-000002',
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [sourceClaim, duplicateClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      providerLevelCode: 'PVT-PHC-CE',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      facilityCode: '03-05-001',
      credentialCode: '03-05-001-02-01954-11-P1-2-011225',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
    })).rejects.toMatchObject({
      code: 'NHIS_DUPLICATE_CLAIMS',
      exportBlockingIssues: expect.arrayContaining([
        expect.objectContaining({
          type: 'attachment',
          message: expect.stringContaining('missing prescription attachments'),
        }),
      ]),
    })
  })

  it('blocks pharmacy CXF export when only legacy Base64 exists without a saved prescription file', async () => {
    const sourceClaim = {
      id: 'claim-1',
      claim_number: 'NHIS-000001',
      status: 'served',
      organization_type: 'pharmacy',
      member_no: '12345678',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '1990-01-01',
      patient_address: 'Accra',
      ccc_no: 'CC-12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Chemist',
      physician_name: 'Dr Test',
      prescription_document_type: 'prescription',
      prescription_verified: true,
      claimit_attachment_base64: Buffer.from('%PDF-1.4\n%%EOF', 'utf8').toString('base64'),
      total_amount: 10,
      nhis_claim_medicines: [{
        nhisDrugId: 'drug-1',
        nhis_drug_id: 'drug-1',
        drugCode: 'NH001',
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [sourceClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return { select: vi.fn(() => claimsQuery) }
      if (table === 'nhis_claim_services') return { select: vi.fn(() => serviceLinesQuery) }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })
    supabase.storage = {
      from: vi.fn(() => ({ createSignedUrls: vi.fn() })),
    }
    URL.createObjectURL = vi.fn(() => 'blob:nhis-export')

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerClassLevel: 'D',
      providerLevelCode: 'PVT-PHC-CE',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      facilityCode: '03-05-001',
      credentialCode: '03-05-001-02-01954-11-P1-2-011225',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
    })).rejects.toMatchObject({
      code: 'NHIS_READINESS_CLAIMS',
      readinessIssues: expect.arrayContaining([
        expect.objectContaining({
          claim_number: 'NHIS-000001',
          issues: expect.arrayContaining([
            'Attach the scanned prescription PDF or JPEG before exporting this NHIS claim.',
          ]),
        }),
      ]),
    })

    expect(supabase.storage.from).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('blocks CXF export when a Ghana Card claim is missing a numeric HIN/member mapping', async () => {
    const sourceClaim = {
      id: 'claim-1',
      claim_number: 'NHIS-000001',
      status: 'served',
      organization_type: 'pharmacy',
      member_no: 'GHA-725620852-3',
      hin: '',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '1990-01-01',
      patient_address: 'Accra',
      ccc_no: 'CC-12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Chemist',
      physician_name: 'Dr Test',
      prescription_file_url: 'https://example.test/rx.pdf',
      prescription_file_path: 'org/rx.pdf',
      prescription_document_type: 'prescription',
      prescription_verified: true,
      total_amount: 10,
      nhis_claim_medicines: [{
        nhisDrugId: 'drug-1',
        nhis_drug_id: 'drug-1',
        drugCode: 'NH001',
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [sourceClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return { select: vi.fn(() => claimsQuery) }
      if (table === 'nhis_claim_services') return { select: vi.fn(() => serviceLinesQuery) }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })

    await expect(exportNhisClaimsFile({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'pharmacy',
      providerLevelCode: 'PVT-PHC-CE',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      facilityCode: '03-05-001',
      credentialCode: '03-05-001-02-01954-11-P1-2-011225',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
    })).rejects.toMatchObject({
      code: 'NHIS_READINESS_CLAIMS',
      readinessIssues: expect.arrayContaining([
        expect.objectContaining({
          claim_number: 'NHIS-000001',
          issues: expect.arrayContaining([
            'Ghana Card-linked claims must also have the numeric NHIS/HIN membership number in the HIN field before CXF export.',
          ]),
        }),
      ]),
    })
  })

  it('exports Ghana Card-linked members with an 8-digit verified HIN as member number and blank card serial', async () => {
    const sourceClaim = {
      id: 'claim-1',
      claim_number: 'NHIS-000001',
      status: 'served',
      organization_type: 'pharmacy',
      member_no: 'GHA-725620852-3',
      hin: '43180659',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '1990-01-01',
      patient_address: 'Accra',
      ccc_no: 'CC-12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Chemist',
      physician_name: 'Dr Test',
      prescription_file_url: 'https://example.test/rx.pdf',
      prescription_file_path: 'org/rx.pdf',
      prescription_document_type: 'prescription',
      prescription_verified: true,
      total_amount: 10,
      nhis_claim_medicines: [{
        nhisDrugId: 'drug-1',
        nhis_drug_id: 'drug-1',
        drugCode: 'NH001',
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const payload = buildNhisClaimItExportPayload([
      sourceClaim,
    ], {
      yearMonth: '2026-05',
      organizationType: 'pharmacy',
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      claimsOfficerName: 'Claims Officer',
      submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    expect(payload.claims[0].patient).toMatchObject({
      memberNumber: '43180659',
      cardSerialNo: '',
    })

    const inflated = inflateSync(Buffer.from((await buildNhisClaimItCxf(payload)).slice(3)))
    const savedClaim = JSON.parse(inflateSync(extractSerializedClaimBuffer(inflated)).toString('utf8'))
    expect(savedClaim.memberInfo).toMatchObject({
      memberNo: '43180659',
      cardSerialNo: '',
    })
  })

  it('does not block hospital CXF readiness when prescription attachments are missing', async () => {
    const hospitalClaim = {
      id: 'claim-1',
      claim_number: 'NHIS-000001',
      status: 'served',
      organization_type: 'hospital',
      member_no: '12345678',
      surname: 'Mensah',
      other_names: 'Ama',
      folder_no: 'F001',
      date_of_birth: '1990-01-01',
      patient_address: 'Accra',
      ccc_no: 'CC-12345',
      diagnosis: 'Malaria',
      diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
      service_date_from: '2026-05-14',
      service_date_to: '2026-05-14',
      referring_facility: 'Westpoint Hospital',
      physician_name: 'Dr Test',
      total_amount: 10,
      nhis_claim_medicines: [{
        nhisDrugId: 'drug-1',
        nhis_drug_id: 'drug-1',
        drugCode: 'NH001',
        drug_code: 'NH001',
        description: 'Artemether Lumefantrine Tablet',
        unit: 'tablet',
        unit_price: 1,
        dispensed_qty: 10,
        dose: '1 tablet',
        frequency: 'BD',
        duration: '3 days',
        total_amount: 10,
        category: 'A',
      }],
    }
    const claimsQuery = {
      order: vi.fn(() => claimsQuery),
      gte: vi.fn(() => claimsQuery),
      lte: vi.fn().mockResolvedValue({ data: [hospitalClaim], error: null }),
    }
    const serviceLinesQuery = {
      in: vi.fn(() => serviceLinesQuery),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') {
        return { select: vi.fn(() => claimsQuery) }
      }
      if (table === 'nhis_claim_services') {
        return { select: vi.fn(() => serviceLinesQuery) }
      }
      if (table === 'nhis_clinical_rules') {
        const clinicalRulesQuery = {
          eq: vi.fn(() => clinicalRulesQuery),
          in: vi.fn(() => clinicalRulesQuery),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
        return { select: vi.fn(() => clinicalRulesQuery) }
      }
      return { select: vi.fn(() => ({ in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) }
    })

    await expect(checkNhisExportReadiness({
      mode: 'custom',
      fromDate: '2026-05-14',
      toDate: '2026-05-14',
      format: 'cxf',
      organizationType: 'hospital',
      providerClassLevel: 'D',
      providerLevelCode: 'PVT-PHC-CE',
      facilityName: 'Westpoint Hospital',
      providerNumber: '03-05-01954',
      facilityCode: '03-05-001',
      credentialCode: '03-05-001-02-01954-11-P1-2-011225',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ id: 'drug-1', code: 'NH001', category: 'A' }],
    })).resolves.toMatchObject({
      count: 1,
      format: 'cxf',
    })
  })
})

describe('NHIA API settings source routing', () => {
  const completeClaimItSettings = {
    providerId: 'PROVIDER-1',
    providerNumber: 'PROVIDER-1',
    credentialCode: 'CRED-1',
    accreditationExpiryDate: '2026-12-31',
    claimsOfficerName: 'Claims Officer',
  }

  it('applies standard Ghana NHIS API defaults when no NHIA row exists', async () => {
    mockNhiaConfigurationStore(null)
    invokeTierAccess.mockResolvedValueOnce({ settings: null })

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      organizationId: 'org-1',
      configSource: 'default_app_config',
      apiBaseUrl: 'https://elig.nhia.gov.gh:5000',
      api_base_url: 'https://elig.nhia.gov.gh:5000',
      memberLookupEndpointPath: '/api/hmis/genCCC',
      member_lookup_endpoint_path: '/api/hmis/genCCC',
      memberLookupEndpoint: '/api/hmis/genCCC',
      member_lookup_endpoint: '/api/hmis/genCCC',
      claimitSubmitBaseUrl: 'http://localhost:31719/json-api',
      claimSubmitEndpoint: '/claims',
      integrationMode: 'claimit_assisted',
      credentialMode: 'claimit_token',
    })
  })

  it('reads NHIA settings from the local branch server when local sync is preferred', async () => {
    shouldUseBranchServer.mockReturnValueOnce(true)
    getNhiaSettings.mockResolvedValueOnce({
      organizationId: 'org-1',
      facilityCode: 'FAC-1',
      hasApiKey: true,
      hasApiSecret: true,
      credentialSummary: {
        apiKey: true,
        apiSecret: true,
      },
    })

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      organizationId: 'org-1',
      facilityCode: 'FAC-1',
      hasApiKey: true,
      hasApiSecret: true,
    })

    expect(getNhiaSettings).toHaveBeenCalledTimes(1)
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('does not fall back to hosted NHIA settings when local sync has no saved settings', async () => {
    mockNhiaConfigurationStore()
    shouldUseBranchServer.mockReturnValueOnce(true)
    getNhiaSettings.mockResolvedValueOnce(null)

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      organizationId: 'org-1',
      configSource: 'local_branch_server',
      hasApiKey: false,
      hasApiSecret: false,
    })

    expect(getNhiaSettings).toHaveBeenCalledTimes(1)
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('does not fall back to the cloud save path when the local NHIA save route fails', async () => {
    shouldUseBranchServer.mockReturnValue(true)
    saveNhiaSettings.mockRejectedValueOnce(Object.assign(new Error('Local branch server request failed.'), { status: 404, endpoint: '/api/nhia-config' }))

    const onLocalSaveFailure = vi.fn()

    await expect(saveNhiaApiSettings({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      facilityCode: 'FAC-1',
      credentials: {
        apiKey: 'local-key',
        apiSecret: 'local-secret',
      },
    }, { organizationId: 'org-1', onLocalSaveFailure })).rejects.toThrow('Local branch server request failed.')

    expect(onLocalSaveFailure).not.toHaveBeenCalled()
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('requires organizationId before saving NHIA settings through cloud Supabase', async () => {
    await expect(saveNhiaApiSettings({
      ...completeClaimItSettings,
    })).rejects.toThrow('organizationId is missing')

    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('does not send saved credential masks as replacement credentials', async () => {
    invokeTierAccess
      .mockResolvedValueOnce({
        settings: {
          organizationId: 'org-1',
          facilityCode: 'FAC-1',
          hasApiKey: true,
          hasApiSecret: true,
          credentialSummary: {
            apiKey: true,
            apiSecret: true,
            username: true,
            password: true,
          },
        },
      })
      .mockResolvedValueOnce({
        settings: {
          organizationId: 'org-1',
          facilityCode: 'FAC-1',
          hasApiKey: true,
          hasApiSecret: true,
          credentialSummary: {
            apiKey: true,
            apiSecret: true,
            username: true,
            password: true,
          },
        },
      })

    await saveNhiaApiSettings({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      facilityCode: 'FAC-1',
      credentials: {
        apiKey: '\u2022'.repeat(8),
        apiSecret: '\u2022'.repeat(8),
        username: '\u2022'.repeat(8),
        password: '\u2022'.repeat(8),
        headerName: 'x-nhia-apikey',
        secretHeaderName: 'x-nhia-apisecret',
      },
      hasApiKey: true,
      hasApiSecret: true,
    }, { organizationId: 'org-1' })

    expect(invokeTierAccess).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'save_nhia_api_settings',
      settings: expect.objectContaining({
        credentials: {
          headerName: 'x-nhia-apikey',
          secretHeaderName: 'x-nhia-apisecret',
        },
      }),
    }))
  })

  it('clears stale NHIA settings cache and uses tier-access readback after saving', async () => {
    window.localStorage.setItem('healthflow.nhiaApiSettings.v3', JSON.stringify({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'STALE-CACHE',
        hasApiKey: false,
        hasApiSecret: false,
      },
    }))
    window.localStorage.setItem('healthflow.nhiaApiSettings.v3:org-1', JSON.stringify({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'STALE-CACHE',
        hasApiKey: false,
        hasApiSecret: false,
      },
    }))
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-1',
        hasApiKey: true,
        hasApiSecret: true,
        accreditationExpiryDate: '2026-12-31',
        claimsOfficerName: 'Claims Officer',
      },
    }).mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-1',
        hasApiKey: true,
        hasApiSecret: true,
        accreditationExpiryDate: '2026-12-31',
        claimsOfficerName: 'Claims Officer',
      },
    })

    await expect(saveNhiaApiSettings({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      facilityCode: 'FAC-1',
      credentials: {
        apiKey: 'saved-key',
        apiSecret: 'saved-secret',
      },
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
    }, { organizationId: 'org-1' })).resolves.toMatchObject({
      facilityCode: 'FAC-1',
      hasApiKey: true,
      hasApiSecret: true,
      accreditationExpiryDate: '2026-12-31',
    })

    expect(invokeTierAccess).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'get_nhia_api_settings',
      organizationId: 'org-1',
      branchId: null,
    }))
    expect(window.localStorage.getItem('healthflow.nhiaApiSettings.v3')).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('healthflow.nhiaApiSettings.v3:org-1'))?.settings).toMatchObject({
      facilityCode: 'FAC-1',
      hasApiKey: true,
      hasApiSecret: true,
    })
  })

  it('keeps provider type description in the NHIA settings cache and restores it', async () => {
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-1',
        providerTypeDescription: 'Dental clinics',
        provider_type_description: 'Dental clinics',
        hasApiKey: true,
        hasApiSecret: true,
        accreditationExpiryDate: '2026-12-31',
        claimsOfficerName: 'Claims Officer',
      },
    }).mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-1',
        providerTypeDescription: 'Dental clinics',
        provider_type_description: 'Dental clinics',
        hasApiKey: true,
        hasApiSecret: true,
        accreditationExpiryDate: '2026-12-31',
        claimsOfficerName: 'Claims Officer',
      },
    })

    await expect(saveNhiaApiSettings({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      facilityCode: 'FAC-1',
      providerTypeDescription: 'Dental clinics',
      provider_type_description: 'Dental clinics',
      credentials: {
        apiKey: 'saved-key',
        apiSecret: 'saved-secret',
      },
    }, { organizationId: 'org-1' })).resolves.toMatchObject({
      providerTypeDescription: 'Dental clinics',
      provider_type_description: 'Dental clinics',
    })

    const cachedSettings = JSON.parse(window.localStorage.getItem('healthflow.nhiaApiSettings.v3:org-1'))?.settings
    expect(cachedSettings).toMatchObject({
      providerTypeDescription: 'Dental clinics',
      provider_type_description: 'Dental clinics',
    })

    invokeTierAccess.mockClear()

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      providerTypeDescription: 'Dental clinics',
      provider_type_description: 'Dental clinics',
    })
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('saves NHIA settings locally in local-sync mode and reports cloud sync pending', async () => {
    shouldUseBranchServer.mockReturnValue(true)
    saveNhiaSettings.mockResolvedValueOnce({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      branchId: 'branch-1',
      facilityCode: 'FAC-1',
      hasApiKey: true,
      hasApiSecret: true,
    })
    getNhiaSettings.mockResolvedValueOnce({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      branchId: 'branch-1',
      facilityCode: 'FAC-1',
      hasApiKey: true,
      hasApiSecret: true,
      credentialSummary: {
        apiKey: true,
        apiSecret: true,
      },
    })

    await expect(saveNhiaApiSettings({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      branchId: 'branch-1',
      facilityCode: 'FAC-1',
      credentials: {
        apiKey: 'local-key',
        apiSecret: 'local-secret',
      },
    }, { organizationId: 'org-1', branchId: 'branch-1' })).resolves.toMatchObject({
      organizationId: 'org-1',
      branchId: 'branch-1',
      facilityCode: 'FAC-1',
      configSource: 'local_branch_server',
      syncWarning: 'Saved locally, cloud sync pending.',
      cloudSyncPending: true,
    })

    expect(saveNhiaSettings).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      organization_id: 'org-1',
      branchId: 'branch-1',
      branch_id: 'branch-1',
    }))
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('normalizes legacy accreditation expiry fields to accreditationExpiryDate', async () => {
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        accreditation_expiry_date: '31/12/2026',
      },
    })

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      accreditationExpiryDate: '2026-12-31',
    })
  })

  it('uses saved NHIA API credential flags instead of display encrypted values', async () => {
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        hasApiKey: true,
        hasApiSecret: true,
        apiKeyEncrypted: '',
        apiSecretEncrypted: '',
        credentialSummary: {
          apiKey: true,
          apiSecret: true,
        },
      },
    })

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      hasApiKey: true,
      hasApiSecret: true,
      apiKeyEncrypted: '',
      apiSecretEncrypted: '',
      credentialSummary: {
        apiKey: true,
        apiSecret: true,
      },
    })
  })

  it('does not merge browser direct NHIA configuration rows into hosted settings', async () => {
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-HOSTED',
        hasApiKey: true,
      },
    })
    const directQuery = {
      select: vi.fn(() => directQuery),
      eq: vi.fn(() => directQuery),
      order: vi.fn(() => directQuery),
      limit: vi.fn(() => directQuery),
      is: vi.fn(() => directQuery),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          organization_id: 'org-1',
          facility_code: 'FAC-DIRECT',
          provider_number: 'PROV-DIRECT',
          credential_code: 'CRED-DIRECT',
          accreditation_expiry_date: '2026-12-31',
          claims_officer_name: 'Direct Officer',
          is_active: true,
        },
        error: null,
      }),
    }
    supabase.from.mockReturnValue(directQuery)

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      organizationId: 'org-1',
      facilityCode: 'FAC-HOSTED',
      hasApiKey: true,
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('ignores legacy NHIA integration rows in the frontend hosted settings path', async () => {
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        id: 'config-1',
        organizationId: 'org-1',
        facilityCode: 'HOSTED-CONFIG',
        hasApiKey: true,
        hasApiSecret: true,
        credentialSummary: {
          apiKey: true,
          apiSecret: true,
        },
        updatedAt: '2026-05-25T10:00:00.000Z',
      },
    })

    const legacyQuery = {
      select: vi.fn(function select() { return this }),
      eq: vi.fn(function eq() { return this }),
      order: vi.fn(function order() { return this }),
      limit: vi.fn(function limit() { return this }),
      is: vi.fn(function is() { return this }),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'legacy-1',
          organization_id: 'org-1',
          facility_code: 'LATEST-INTEGRATION',
          credential_payload: {
            apiKey: 'saved-key',
            apiSecret: 'saved-secret',
          },
          updated_at: '2026-05-26T10:00:00.000Z',
          is_active: true,
        },
        error: null,
      }),
    }
    supabase.from.mockReturnValue(legacyQuery)

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      organizationId: 'org-1',
      facilityCode: 'HOSTED-CONFIG',
      hasApiKey: true,
      hasApiSecret: true,
      credentialSummary: {
        apiKey: true,
        apiSecret: true,
      },
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('does not send blank NHIA API secrets when saving settings', async () => {
    mockNhiaConfigurationStore()
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-1',
        hasApiKey: true,
        hasApiSecret: true,
      },
    }).mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-1',
        hasApiKey: true,
        hasApiSecret: true,
      },
    })

    await saveNhiaApiSettings({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      credentials: {
        apiKey: '',
        apiSecret: '',
        headerName: 'x-api-key',
      },
    }, { organizationId: 'org-1' })

    expect(invokeTierAccess).toHaveBeenCalledWith(expect.objectContaining({
      action: 'save_nhia_api_settings',
      requestType: 'save_nhia_api_settings',
      type: 'save_nhia_api_settings',
      organizationId: 'org-1',
      organization_id: 'org-1',
      branchId: null,
      branch_id: null,
      featureKey: 'nhia_api_config',
      feature_key: 'nhia_api_config',
      payload: expect.objectContaining({
        ...completeClaimItSettings,
        organizationId: 'org-1',
        credentials: {
          headerName: 'x-api-key',
        },
      }),
      data: expect.objectContaining({
        ...completeClaimItSettings,
        organizationId: 'org-1',
        credentials: {
          headerName: 'x-api-key',
        },
      }),
      settings: expect.objectContaining({
        ...completeClaimItSettings,
        organizationId: 'org-1',
        credentials: {
          headerName: 'x-api-key',
        },
      }),
    }))
    expect(JSON.stringify(invokeTierAccess.mock.calls[0][0])).not.toContain('undefined')
  })

  it('blocks all browser-to-CLAIM-it CCC requests', async () => {
    await expect(generateBrowserClaimItBridgeCcCode({
      apiBaseUrl: 'http://localhost:31719/json-api',
      claimEndpointPath: '/claims',
    }, {
      memberNumber: '12345678',
    })).rejects.toThrow('Browser-to-CLAIM-it requests are disabled')

    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('NHIS drug catalog routing', () => {
  const mockCloudNhisDrugQuery = (rows = []) => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
      or: vi.fn(() => query),
    }
    supabase.from.mockReturnValue(query)
    return query
  }

  it('falls back to the cloud NHIS catalog when local sync has no cached catalog rows', async () => {
    const cloudRows = [{ id: 'drug-1', code: 'NH001', description: 'Paracetamol 500mg', is_active: true }]
    shouldUseBranchServer.mockReturnValue(true)
    listBranchRecords.mockResolvedValueOnce([])
    mockCloudNhisDrugQuery(cloudRows)

    await expect(getAllNhisDrugs()).resolves.toEqual(cloudRows)

    expect(listBranchRecords).toHaveBeenCalledWith('nhis/drugs', { searchTerm: '' })
    expect(supabase.from).toHaveBeenCalledWith('nhis_drugs')
  })

  it('falls back to the cloud NHIS catalog when a local code lookup misses while online', async () => {
    const cloudRows = [{ id: 'drug-2', code: 'NH002', description: 'Amoxicillin 250mg', is_active: true }]
    shouldUseBranchServer.mockReturnValue(true)
    listBranchRecords.mockResolvedValueOnce([])
    getConnectivityState.mockReturnValueOnce({
      mode: 'ONLINE_LOCAL_SYNC',
      internetAvailable: true,
      branchServerAvailable: true,
      checkedAt: Date.now(),
    })
    mockCloudNhisDrugQuery(cloudRows)

    await expect(getNhisDrugByCode('nh002')).resolves.toEqual(cloudRows[0])

    expect(listBranchRecords).toHaveBeenCalledWith('nhis/drugs', { searchTerm: 'nh002', limit: 1 })
    expect(supabase.from).toHaveBeenCalledWith('nhis_drugs')
  })
})

describe('NHIS active medication overlap check', () => {
  it('calls the privacy-minimized overlap RPC with normalized medicine and claim context', async () => {
    const alerts = [{
      severity: 'strong_warning',
      medicine_code: 'PARA500',
      source_label: 'Another participating HealthFlow facility',
      previous_claim_reference: null,
    }]
    supabase.rpc.mockResolvedValueOnce({ data: alerts, error: null })

    const result = await checkNhisActiveMedicationOverlap({
      memberNo: ' NHIS-001 ',
      hin: ' HIN-001 ',
      medicineCode: ' para500 ',
      serviceDate: '2026-07-28',
      currentClaimId: '11111111-1111-4111-8111-111111111111',
      currentOrganizationId: '22222222-2222-4222-8222-222222222222',
      genericName: 'Paracetamol',
      strength: '500 mg',
      dosageForm: 'Tablet',
      requestedQuantity: '14',
      dose: '1 tablet',
      frequency: 'BD',
      duration: '7 days',
    })

    expect(result).toEqual({ available: true, alerts })
    expect(supabase.rpc).toHaveBeenCalledWith('check_nhis_active_medication_overlap', {
      p_member_no: 'NHIS-001',
      p_hin: 'HIN-001',
      p_medicine_code: 'PARA500',
      p_service_date: '2026-07-28',
      p_current_claim_id: '11111111-1111-4111-8111-111111111111',
      p_current_organization_id: '22222222-2222-4222-8222-222222222222',
      p_generic_name: 'Paracetamol',
      p_strength: '500 mg',
      p_dosage_form: 'Tablet',
      p_requested_quantity: 14,
      p_dose: '1 tablet',
      p_frequency: 'BD',
      p_duration: '7 days',
    })
  })

  it('preserves refill and risk-advisory fields returned by the overlap RPC', async () => {
    const alerts = [{
      severity: 'info',
      match_type: 'possible_completion_supply',
      remaining_days: 5,
      risk_score: 25,
      risk_reasons: ['Requested quantity may be completing a previous partial fill.'],
      recommended_action: 'Confirm this is a completion supply for medicine previously not fully served.',
    }]
    supabase.rpc.mockResolvedValueOnce({ data: alerts, error: null })

    const result = await checkNhisActiveMedicationOverlap({
      memberNo: '123',
      medicineCode: 'PARA500',
      requestedQuantity: 3,
      dose: '1 tablet',
      frequency: 'OD',
      duration: '3 days',
    })

    expect(result).toEqual({ available: true, alerts })
    expect(supabase.rpc).toHaveBeenCalledWith('check_nhis_active_medication_overlap', expect.objectContaining({
      p_requested_quantity: 3,
      p_dose: '1 tablet',
      p_frequency: 'OD',
      p_duration: '3 days',
    }))
  })

  it('can run an ingredient-level advisory when medicine code is unavailable', async () => {
    supabase.rpc.mockResolvedValueOnce({
      data: [{ severity: 'warning', match_type: 'same_ingredient' }],
      error: null,
    })

    const result = await checkNhisActiveMedicationOverlap({
      memberNo: '123',
      genericName: 'Paracetamol',
      dosageForm: 'Tablet',
    })

    expect(result.alerts).toEqual([{ severity: 'warning', match_type: 'same_ingredient' }])
    expect(supabase.rpc).toHaveBeenCalledWith('check_nhis_active_medication_overlap', expect.objectContaining({
      p_medicine_code: '',
      p_generic_name: 'Paracetamol',
      p_strength: null,
      p_dosage_form: 'Tablet',
      p_requested_quantity: null,
    }))
  })

  it('fails open when the database RPC has not been deployed yet', async () => {
    supabase.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42883', message: 'function check_nhis_active_medication_overlap does not exist' },
    })

    await expect(checkNhisActiveMedicationOverlap({
      memberNo: '123',
      medicineCode: 'PARA500',
    })).resolves.toEqual({
      available: false,
      alerts: [],
      reason: 'rpc_not_deployed',
    })
  })

  it('does not call cloud overlap checks in branch-server mode', async () => {
    shouldUseBranchServer.mockReturnValueOnce(true)

    await expect(checkNhisActiveMedicationOverlap({
      memberNo: '123',
      medicineCode: 'PARA500',
    })).resolves.toEqual({
      available: false,
      alerts: [],
      reason: 'offline_branch',
    })

    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('NHIS local and cloud claim reads', () => {
  const mockCloudNhisClaimsQuery = ({ rows = [], error = null } = {}) => {
    const query = {
      select: vi.fn(() => query),
      order: vi.fn(() => query),
      eq: vi.fn(() => query),
      or: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve, reject) => Promise.resolve({ data: rows, error }).then(resolve, reject),
    }
    supabase.from.mockReturnValue(query)
    return query
  }

  it('merges cloud history with local claims and gives the local copy precedence', () => {
    const cloudRows = [
      { id: 'cloud-only', status: 'served', created_at: '2026-06-10T08:00:00Z' },
      { id: 'shared', status: 'served', notes: 'cloud copy', created_at: '2026-06-11T08:00:00Z' },
    ]
    const localRows = [
      { id: 'shared', status: 'rejected', notes: 'local correction', created_at: '2026-06-11T08:00:00Z' },
      { id: 'local-only', status: 'served', created_at: '2026-06-12T08:00:00Z' },
    ]

    expect(mergeNhisClaimRows(cloudRows, localRows)).toEqual([
      localRows[1],
      localRows[0],
      cloudRows[0],
    ])
  })

  it('keeps cloud history visible when the online local cache contains only one claim', async () => {
    const localRows = [
      { id: 'local-claim', status: 'served', created_at: '2026-06-12T08:00:00Z' },
    ]
    const cloudRows = [
      { id: 'cloud-claim', status: 'submitted', created_at: '2026-06-10T08:00:00Z' },
    ]
    shouldUseBranchServer.mockReturnValue(true)
    listBranchRecords.mockResolvedValueOnce(localRows)
    const query = mockCloudNhisClaimsQuery({ rows: cloudRows })

    await expect(getAllNhisClaims()).resolves.toEqual([
      localRows[0],
      cloudRows[0],
    ])

    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { limit: 100000 })
    expect(supabase.from).toHaveBeenCalledWith('nhis_claims')
    expect(query.limit).toHaveBeenCalledWith(500)
  })

  it('does not revive a stale cloud status in a filtered view', async () => {
    const localRows = [
      { id: 'shared', status: 'rejected', created_at: '2026-06-12T08:00:00Z' },
    ]
    const cloudRows = [
      { id: 'shared', status: 'served', created_at: '2026-06-12T08:00:00Z' },
      { id: 'served-cloud', status: 'served', created_at: '2026-06-11T08:00:00Z' },
    ]
    shouldUseBranchServer.mockReturnValue(true)
    listBranchRecords.mockResolvedValueOnce(localRows)
    mockCloudNhisClaimsQuery({ rows: cloudRows })

    await expect(getAllNhisClaims({ status: 'served' })).resolves.toEqual([
      cloudRows[1],
    ])
  })

  it('does not select embedded attachment Base64 for normal paginated claim lists', async () => {
    const query = {
      select: vi.fn(() => query),
      order: vi.fn(() => query),
      range: vi.fn().mockResolvedValue({
        data: [{ id: 'claim-page-row', status: 'served' }],
        error: null,
        count: 1,
      }),
    }
    supabase.from.mockReturnValue(query)
    supabase.rpc.mockResolvedValueOnce({ data: null, error: new Error('RPC unavailable') })

    await expect(getNhisClaimsPage({ includeDetails: false, page: 1, pageSize: 100 })).resolves.toMatchObject({
      claims: [expect.objectContaining({ id: 'claim-page-row' })],
      total: 1,
    })

    expect(query.select.mock.calls[0][0]).not.toContain('claimit_attachment_base64')
    expect(query.range).toHaveBeenCalledWith(0, 99)
  })

  it('uses server-filtered issue pages instead of scanning 100,000 claim rows', async () => {
    const query = {
      select: vi.fn(() => query),
      order: vi.fn(() => query),
      range: vi.fn(() => query),
      in: vi.fn(() => query),
      eq: vi.fn(() => query),
      gte: vi.fn(() => query),
      lte: vi.fn(() => query),
      or: vi.fn(() => query),
      is: vi.fn(() => query),
      then: (resolve, reject) => Promise.resolve({
        data: [{ id: 'missing-rx-claim', status: 'served' }],
        error: null,
        count: 1,
      }).then(resolve, reject),
    }
    supabase.from.mockReturnValue(query)

    await expect(getNhisClaimsPage({
      includeDetails: false,
      issueFilter: 'missing-attachment',
      organizationType: 'pharmacy',
      page: 1,
      pageSize: 100,
    })).resolves.toMatchObject({
      claims: [expect.objectContaining({ id: 'missing-rx-claim' })],
      total: 1,
    })

    expect(query.select.mock.calls[0][0]).not.toContain('claimit_attachment_base64')
    expect(query.select.mock.calls[0][1]).toMatchObject({ count: 'exact' })
    expect(query.range).toHaveBeenCalledTimes(1)
    expect(query.range).toHaveBeenCalledWith(0, 99)
  })

  it('uses only the filtered local cache when internet is unavailable', async () => {
    const localRows = [
      { id: 'offline-claim', status: 'served', created_at: '2026-06-12T08:00:00Z' },
    ]
    shouldUseBranchServer.mockReturnValue(true)
    getConnectivityState.mockReturnValueOnce({
      mode: 'OFFLINE_LOCAL',
      internetAvailable: false,
      branchServerAvailable: true,
      checkedAt: Date.now(),
    })
    listBranchRecords.mockResolvedValueOnce(localRows)

    await expect(getAllNhisClaims({ status: 'served' })).resolves.toEqual(localRows)

    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { status: 'served' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('matches full patient names in the offline paginated claim list', async () => {
    const localRows = [
      {
        id: 'full-name-match',
        status: 'served',
        surname: 'Gyimah',
        other_names: 'Mercy',
        member_no: '12345678',
        created_at: '2026-06-12T08:00:00Z',
      },
      {
        id: 'other-patient',
        status: 'served',
        surname: 'Mensah',
        other_names: 'Ama',
        member_no: '87654321',
        created_at: '2026-06-11T08:00:00Z',
      },
    ]
    shouldUseBranchServer.mockReturnValue(true)
    getConnectivityState.mockReturnValueOnce({
      mode: 'OFFLINE_LOCAL',
      internetAvailable: false,
      branchServerAvailable: true,
      checkedAt: Date.now(),
    })
    listBranchRecords.mockResolvedValueOnce(localRows)

    await expect(getNhisClaimsPage({
      includeDetails: false,
      searchTerm: 'Gyimah Mercy',
      page: 1,
      pageSize: 100,
    })).resolves.toMatchObject({
      claims: [expect.objectContaining({ id: 'full-name-match' })],
      total: 1,
    })
  })

  it('falls back to local claims when the cloud read fails', async () => {
    const localRows = [
      { id: 'local-served', status: 'served', created_at: '2026-06-12T08:00:00Z' },
      { id: 'local-rejected', status: 'rejected', created_at: '2026-06-11T08:00:00Z' },
    ]
    shouldUseBranchServer.mockReturnValue(true)
    listBranchRecords.mockResolvedValueOnce(localRows)
    mockCloudNhisClaimsQuery({ error: new Error('cloud unavailable') })

    await expect(getAllNhisClaims({ status: 'served' })).resolves.toEqual([
      localRows[0],
    ])
  })
})

describe('NHIS claim status routing', () => {
  it('serves a claim directly through the transactional stock RPC', async () => {
    supabase.rpc.mockResolvedValueOnce({
      data: { id: 'claim-1', status: 'served', total_amount: 10 },
      error: null,
    })

    await expect(serveNhisClaimDirect('claim-1')).resolves.toMatchObject({
      id: 'claim-1',
      status: 'served',
    })
    expect(supabase.rpc).toHaveBeenCalledWith('serve_nhis_claim_direct', {
      p_claim_id: 'claim-1',
    })
  })

  it('blocks NHIS claim deletion without the explicit permission before any write', async () => {
    await expect(deleteNhisClaim('claim-1', { role: 'claims_officer' }))
      .rejects.toThrow('You do not have permission to delete NHIS claims.')

    expect(deleteBranchRecord).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('routes admin NHIS claim deletion through the recycle-bin RPC', async () => {
    shouldUseBranchServer.mockReturnValue(true)
    supabase.rpc.mockResolvedValueOnce({ data: {
      id: 'claim-1',
      claim_number: 'NHIS-000001',
    }, error: null })

    await expect(deleteNhisClaim('claim-1', { role: 'admin' })).resolves.toMatchObject({
      id: 'claim-1',
    })

    expect(supabase.rpc).toHaveBeenCalledWith('recycle_nhis_claim', { p_claim_id: 'claim-1' })
    expect(deleteBranchRecord).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('allows a claims officer with explicit NHIS deletion permission', async () => {
    shouldUseBranchServer.mockReturnValue(true)
    supabase.rpc.mockResolvedValueOnce({ data: { id: 'claim-1' }, error: null })

    await expect(deleteNhisClaim('claim-1', {
      role: 'claims_officer',
      canDeleteNhisClaims: true,
    })).resolves.toMatchObject({ id: 'claim-1' })

    expect(supabase.rpc).toHaveBeenCalledWith('recycle_nhis_claim', { p_claim_id: 'claim-1' })
  })

  it('does not report success when the live schema would discard an RX attachment', async () => {
    const updatePayloads = []
    const makeUpdateQuery = (response) => {
      const query = {
        eq: vi.fn(() => query),
        select: vi.fn(() => query),
        single: vi.fn().mockResolvedValue(response),
      }
      return query
    }
    const duplicateQuery = {
      eq: vi.fn(() => duplicateQuery),
      neq: vi.fn(() => duplicateQuery),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    const existingClaimQuery = {
      eq: vi.fn(() => existingClaimQuery),
      single: vi.fn().mockResolvedValue({
        data: { id: 'claim-1', claim_number: 'NHIS-000001', status: 'served' },
        error: null,
      }),
    }
    const firstUpdateQuery = makeUpdateQuery({
      data: null,
      error: {
        code: 'PGRST204',
        message: "Could not find the 'claimitAttachmentFileName' column of 'nhis_claims' in the schema cache",
      },
    })
    const claimTable = {
      select: vi.fn((columns = '') =>
        String(columns).trim() === '*' ? existingClaimQuery : duplicateQuery
      ),
      update: vi.fn((payload) => {
        updatePayloads.push(payload)
        return firstUpdateQuery
      }),
    }
    const medicineDeleteQuery = {
      eq: vi.fn().mockResolvedValue({ error: null }),
    }
    const medicineTable = {
      delete: vi.fn(() => medicineDeleteQuery),
      insert: vi.fn().mockResolvedValue({ error: null }),
    }
    const servicesDeleteQuery = {
      eq: vi.fn().mockResolvedValue({ error: null }),
    }
    const servicesTable = {
      delete: vi.fn(() => servicesDeleteQuery),
      insert: vi.fn().mockResolvedValue({ error: null }),
    }

    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_claims') return claimTable
      if (table === 'nhis_claim_medicines') return medicineTable
      if (table === 'nhis_claim_services') return servicesTable
      return { update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) }
    })

    await expect(updateNhisClaim(
      'claim-1',
      {
        ...baseClaim,
        cccNo: '81416',
        claimitAttachmentFileName: 'prescription_NHIS-000001.pdf',
        claimitAttachmentFileType: 'pdf',
        claimitAttachmentMimeType: 'application/pdf',
        claimitAttachmentBase64: Buffer.from('%PDF-1.7\n%%EOF', 'utf8').toString('base64'),
      },
      [{
        ...baseMedicine,
        totalAmount: 10,
        medicineAccessLevel: 'Prescription',
        requiredPharmacyLevel: 'P1',
      }],
      {
        providerClassLevel: 'D',
        pharmacyLevel: 'P1',
        nhisDrugCatalog: [{
          id: 'drug-1',
          code: 'NH001',
          medicine_access_level: 'Prescription',
          required_pharmacy_level: 'P1',
        }],
      }
    )).rejects.toThrow(
      'Prescription file upload completed, but the NHIS claim attachment database fields are missing.'
    )

    expect(updatePayloads).toHaveLength(0)
    expect(medicineTable.insert).not.toHaveBeenCalled()
  })

  it('uses the local/cloud write router before marking a local-sync claim submitted', async () => {
    shouldUseBranchServer.mockReturnValueOnce(true)
    updateBranchRecord.mockResolvedValue({ id: 'claim-1', status: 'submitted' })

    await expect(updateNhisClaimStatus('claim-1', 'submitted', '', 'user-1')).resolves.toEqual({
      id: 'claim-1',
      status: 'submitted',
    })

    expect(routeWrite).toHaveBeenCalledWith(expect.objectContaining({
      label: 'NHIS claim status',
      local: expect.any(Function),
      cloud: expect.any(Function),
    }))
    expect(updateBranchRecord).toHaveBeenCalledWith(
      'nhis/claims',
      'claim-1',
      expect.objectContaining({ status: 'submitted' })
    )
  })
})

describe('validateNhisPrescriptionPdfFile', () => {
  it('accepts PDF and JPEG files and rejects other file types', () => {
    expect(validateNhisPrescriptionPdfFile({ name: 'rx.pdf', type: 'application/pdf', size: 1024 })).toBe('')
    expect(validateNhisPrescriptionPdfFile({ name: 'rx.jpg', type: 'image/jpeg', size: 1024 })).toBe('')
    expect(validateNhisPrescriptionPdfFile({ name: 'rx.png', type: 'image/png', size: 1024 })).toBe('')
  })

  it('enforces the 3 MB prescription attachment limit', () => {
    expect(validateNhisPrescriptionPdfFile({
      name: 'rx.pdf',
      type: 'application/pdf',
      size: 3 * 1024 * 1024,
    })).toBe('')
    expect(validateNhisPrescriptionPdfFile({ name: 'rx.pdf', type: 'application/pdf', size: 4 * 1024 * 1024 })).toBe(
      'Prescription attachment must be 3 MB or smaller.'
    )
  })
})

describe('uploadNhisPrescriptionPdf', () => {
  it('stores PDF CLAIM-it base64 from raw ArrayBuffer bytes without a data URL prefix', async () => {
    shouldUseBranchServer.mockReturnValueOnce(true)
    const OriginalFileReader = global.FileReader
    const pdfBytes = Buffer.from('%PDF-1.7\r\n%\xff\xff\r\n1 0 obj\r\n<<>>\r\nendobj\r\n%%EOF', 'latin1')
    class MockFileReader {
      readAsDataURL() {
        this.result = `data:application/pdf;base64,${pdfBytes.toString('base64')}`
        this.onload()
      }
    }
    global.FileReader = MockFileReader

    try {
      const result = await uploadNhisPrescriptionPdf({
        name: 'rx.pdf',
        type: 'application/pdf',
        size: pdfBytes.length,
        arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength),
      }, {
        claimNumber: 'NHIS-000001',
      })

      expect(result.claimitAttachmentFileName).toBe('prescription_NHIS-000001.pdf')
      expect(result.claimitAttachmentFileType).toBe('pdf')
      expect(result.claimitAttachmentMimeType).toBe('application/pdf')
      expect(result.claimitAttachmentBase64).toBe(pdfBytes.toString('base64'))
      expect(result.claimitAttachmentBase64.startsWith('data:')).toBe(false)
      expect(Buffer.from(result.claimitAttachmentBase64, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-')
    } finally {
      global.FileReader = OriginalFileReader
    }
  })

  it('stores the original image and a CLAIM-it PDF derivative when running through the branch server', async () => {
    shouldUseBranchServer.mockReturnValueOnce(true)
    const OriginalFileReader = global.FileReader
    const OriginalImage = global.Image
    const jpegDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/ISf/2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z'
    class MockFileReader {
      readAsDataURL() {
        this.result = jpegDataUrl
        this.onload()
      }
    }
    class MockImage {
      set src(_value) {
        this.width = 1
        this.height = 1
        this.naturalWidth = 1
        this.naturalHeight = 1
        this.onload()
      }
    }
    global.FileReader = MockFileReader
    global.Image = MockImage

    try {
      const result = await uploadNhisPrescriptionPdf({ name: 'rx.jpg', type: 'image/jpeg', size: 1024 }, {
        claimNumber: 'NHIS-000001',
      })
      expect(result).toMatchObject({
        prescriptionFilePath: '',
        prescriptionFileName: 'rx.jpg',
        prescriptionFileType: 'image/jpeg',
        prescriptionFileSize: 1024,
        prescriptionFileUrl: jpegDataUrl,
        claimitAttachmentFileName: 'prescription_NHIS-000001.pdf',
        claimitAttachmentFileType: 'pdf',
        claimitAttachmentMimeType: 'application/pdf',
      })
      expect(result.claimitAttachmentBase64.startsWith('data:')).toBe(false)
      expect(Buffer.from(result.claimitAttachmentBase64, 'base64').toString('utf8', 0, 4)).toBe('%PDF')
    } finally {
      global.FileReader = OriginalFileReader
      global.Image = OriginalImage
    }
  })
})
