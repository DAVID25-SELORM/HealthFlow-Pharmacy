import { describe, expect, it, vi } from 'vitest'

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
  listBranchRecords: vi.fn(),
  shouldUseBranchServer: vi.fn(() => false),
  updateBranchRecord: vi.fn(),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess: vi.fn(),
}))

import { assessNhisClaimReadiness } from './nhisService'

const baseClaim = {
  memberNo: '12345678',
  surname: 'Mensah',
  otherNames: 'Ama',
  patientAddress: 'Accra',
  dateOfBirth: '1990-01-01',
  cccNo: 'CC-12345',
  serviceDate: '2026-05-14',
  physicianName: 'Dr Test',
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

describe('assessNhisClaimReadiness', () => {
  it('requires dose, frequency, and duration for pharmacy and hospital claims', () => {
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

    expect(pharmacy.blockers).toEqual(expect.arrayContaining([
      'Medicine 1: dose is required.',
      'Medicine 1: dosage schedule/frequency is required.',
      'Medicine 1: duration is required.',
    ]))
    expect(hospital.blockers).toEqual(expect.arrayContaining([
      'Medicine 1: dose is required.',
      'Medicine 1: dosage schedule/frequency is required.',
      'Medicine 1: duration is required.',
    ]))
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
