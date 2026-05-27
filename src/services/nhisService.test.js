import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inflateSync } from 'node:zlib'

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('./branchServerApi', () => ({
  createBranchRecord: vi.fn(),
  getNhiaSettings: vi.fn(),
  listBranchRecords: vi.fn(),
  saveNhiaSettings: vi.fn(),
  shouldUseBranchServer: vi.fn(() => false),
  submitNhiaDirectPayload: vi.fn(),
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
  buildNhisClaimItXml,
  exportNhisClaimsFile,
  generateBrowserClaimItBridgeCcCode,
  getNhiaApiSettings,
  normalizeNhisExportPeriod,
  saveNhiaApiSettings,
  submitNhisClaimDirect,
  updateNhisClaimStatus,
  uploadNhisPrescriptionPdf,
  validateNhisPrescriptionPdfFile,
} from './nhisService'
import { supabase } from '../lib/supabase'
import { getNhiaSettings, saveNhiaSettings, shouldUseBranchServer, updateBranchRecord } from './branchServerApi'
import { routeWrite } from './apiRouter'
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
  'Malaria: treatment does not appear to match the diagnosis. Correct the diagnosis or add a matching medicine before saving corrections/submission.'

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

    expect(readiness.blockers).toContain(mismatchBlocker)
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

    expect(readiness.blockers).not.toContain(mismatchBlocker)
    expect(readiness.blockers.join(' ')).not.toContain('Medicine 2: Paracetamol Tablet appears to be')
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

    expect(readiness.blockers).toContain(mismatchBlocker)
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

    expect(readiness.blockers).toContain(mismatchBlocker)
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
    const pharmacyLevelBlocked = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'A', medicineAccessLevel: 'Controlled', requiredPharmacyLevel: 'HP' }],
      { enforcePrescribingLevel: true, providerClassLevel: 'SM', pharmacyLevel: 'P1' }
    )

    expect(providerClassIgnored.blockers).not.toEqual(expect.arrayContaining([
      expect.stringContaining('requires NHIS prescribing level C'),
    ]))
    expect(pharmacyLevelBlocked.blockers).toContain(
      'Medicine 1: This medicine is not allowed for your pharmacy/facility level and may cause NHIS claim rejection.'
    )
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
    hin: 'HIN-1',
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

  it('builds a CLAIM-it JSON payload with diagnoses, medicines, and prescription attachment metadata', () => {
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
    expect(payload.claims[0].prescriptionAttachment.fileName).toBe('prescription_NHIS-000001.pdf')
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
        memberNo: 'GHA-123456789-0',
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
    const updateQuery = {
      in: vi.fn().mockResolvedValue({ error: null }),
    }
    supabase.from.mockReturnValue({
      update: vi.fn(() => updateQuery),
    })
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
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
    })

    expect(invokeTierAccess).toHaveBeenCalledWith(expect.objectContaining({
      action: 'submit_nhia_claims_direct',
      submissionAction: 'nhis.direct_claim_submit',
      claimIds: ['claim-1'],
    }))
  })

  it('routes public CLAIM-it bridge URLs through the hosted tier-access proxy', async () => {
    const updateQuery = {
      in: vi.fn().mockResolvedValue({ error: null }),
    }
    supabase.from.mockReturnValue({
      update: vi.fn(() => updateQuery),
    })
    invokeTierAccess.mockResolvedValue({ source: 'hosted', httpStatus: 200, response: { accepted: true } })

    await submitNhisClaimDirect('claim-1', {
      claim: directClaim,
      directApiSource: 'hosted',
      integrationMode: 'claimit_bridge',
      connectionProfile: 'local_server',
      apiBaseUrl: 'https://claims.example.test/json-api',
      claimEndpointPath: '/claims',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
    })

    expect(fetch).not.toHaveBeenCalledWith(
      'https://claims.example.test/json-api/claims',
      expect.any(Object)
    )
    expect(invokeTierAccess).toHaveBeenCalledWith(expect.objectContaining({
      action: 'submit_nhia_claims_direct',
      submissionAction: 'nhis.direct_claim_submit',
    }))
  })

  it('keeps browser bridge submission only for local CLAIM-it bridge URLs', async () => {
    const updateQuery = {
      in: vi.fn().mockResolvedValue({ error: null }),
    }
    supabase.from.mockReturnValue({
      update: vi.fn(() => updateQuery),
    })
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ accepted: true })),
    })

    await submitNhisClaimDirect('claim-1', {
      claim: directClaim,
      directApiSource: 'hosted',
      integrationMode: 'claimit_bridge',
      connectionProfile: 'local_server',
      apiBaseUrl: 'http://localhost:31719/json-api',
      claimEndpointPath: '/claims',
      providerClassLevel: 'D',
      pharmacyLevel: 'P1',
      nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
    })

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:31719/json-api/claims',
      expect.objectContaining({ method: 'POST' })
    )
    expect(invokeTierAccess).not.toHaveBeenCalled()
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

  it('does not mix hosted NHIA settings with cached partial settings', async () => {
    mockNhiaConfigurationStore()
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-1',
        accreditationExpiryDate: '2026-12-31',
        claimsOfficerName: 'Claims Officer',
      },
    })

    await expect(saveNhiaApiSettings({
      ...completeClaimItSettings,
      organizationId: 'org-1',
      facilityCode: 'FAC-1',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Claims Officer',
    }, { organizationId: 'org-1' })).resolves.toMatchObject({
      accreditationExpiryDate: '2026-12-31',
    })

    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
        facilityCode: 'FAC-1',
      },
    })

    const reloaded = await getNhiaApiSettings({ organizationId: 'org-1' })
    expect(reloaded).toMatchObject({
      organizationId: 'org-1',
      facilityCode: 'FAC-1',
      configSource: 'cloud_supabase',
    })
    expect(reloaded.accreditationExpiryDate).toBe('2026-12-31')
    expect(reloaded.claimsOfficerName).toBe('Claims Officer')
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

  it('merges direct NHIA configuration rows when the hosted response is partial', async () => {
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
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
      facilityCode: 'FAC-DIRECT',
      providerNumber: 'PROV-DIRECT',
      credentialCode: 'CRED-DIRECT',
      accreditationExpiryDate: '2026-12-31',
      claimsOfficerName: 'Direct Officer',
      hasApiKey: true,
    })
  })

  it('prefers the latest active legacy NHIA integration row and maps credential payload flags', async () => {
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        id: 'config-1',
        organizationId: 'org-1',
        facilityCode: 'STALE-CONFIG',
        updatedAt: '2026-05-25T10:00:00.000Z',
      },
    })

    const makeQuery = (data) => ({
      select: vi.fn(function select() { return this }),
      eq: vi.fn(function eq() { return this }),
      order: vi.fn(function order() { return this }),
      limit: vi.fn(function limit() { return this }),
      is: vi.fn(function is() { return this }),
      maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    })

    const configQuery = makeQuery({
      id: 'config-1',
      organization_id: 'org-1',
      facility_code: 'STALE-CONFIG',
      updated_at: '2026-05-25T10:00:00.000Z',
      is_active: true,
    })
    const legacyQuery = makeQuery({
      id: 'legacy-1',
      organization_id: 'org-1',
      facility_code: 'LATEST-INTEGRATION',
      credential_code: 'api_key',
      credential_payload: {
        apiKey: 'saved-key',
        apiSecret: 'saved-secret',
      },
      updated_at: '2026-05-26T10:00:00.000Z',
      is_active: true,
    })

    supabase.from.mockImplementation((table) => {
      if (table === 'organization_nhia_integrations') return legacyQuery
      return configQuery
    })

    await expect(getNhiaApiSettings({ organizationId: 'org-1' })).resolves.toMatchObject({
      organizationId: 'org-1',
      facilityCode: 'LATEST-INTEGRATION',
      hasApiKey: true,
      hasApiSecret: true,
      credentialSummary: {
        apiKey: true,
        apiSecret: true,
      },
    })
  })

  it('does not send blank NHIA API secrets when saving settings', async () => {
    mockNhiaConfigurationStore()
    invokeTierAccess.mockResolvedValueOnce({
      settings: {
        organizationId: 'org-1',
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

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'save_nhia_api_settings',
      settings: expect.objectContaining({
        ...completeClaimItSettings,
        organizationId: 'org-1',
        credentials: {
          headerName: 'x-api-key',
        },
      }),
    })
  })

  it('uses the claim endpoint as the CLAIM-it CC code endpoint fallback', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ ccCode: '12345' })),
    })

    await expect(generateBrowserClaimItBridgeCcCode({
      apiBaseUrl: 'http://localhost:31719/json-api',
      claimEndpointPath: '/claims',
      credentialMode: 'api_key',
      credentials: {
        apiKey: 'api-key',
        apiSecret: 'api-secret',
        headerName: 'Authorization',
        secretHeaderName: 'x-api-secret',
      },
    }, {
      organizationType: 'pharmacy',
      patientName: 'Ama Mensah',
      memberNumber: '12345678',
      serviceDate: '2026-05-26',
      totalAmount: 12,
    })).resolves.toMatchObject({
      ccCode: '12345',
      source: 'claimit_bridge',
    })

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:31719/json-api/claims',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'api-key',
          'x-api-secret': 'api-secret',
        }),
      })
    )
  })
})

describe('NHIS claim status routing', () => {
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
