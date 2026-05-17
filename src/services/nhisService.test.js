import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  submitNhiaDirectPayload: vi.fn(),
  updateBranchRecord: vi.fn(),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess: vi.fn(),
}))

import {
  assessNhisClaimReadiness,
  buildNhisClaimItExportPayload,
  buildNhisClaimItXml,
  normalizeNhisExportPeriod,
  submitNhisClaimDirect,
  validateNhisPrescriptionPdfFile,
} from './nhisService'
import { supabase } from '../lib/supabase'
import { invokeTierAccess } from './tierAccessService'

beforeEach(() => {
  vi.clearAllMocks()
})

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

  it('blocks medicines above the configured NHIA provider class level', () => {
    const readiness = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'C' }],
      { enforcePrescribingLevel: true, providerClassLevel: 'B2' }
    )

    expect(readiness.blockers).toContain(
      'Medicine 1: requires NHIS prescribing level C, but this facility is configured as B2. Use an authorized prescriber/facility or remove the medicine.'
    )
  })

  it('allows medicines at or below provider class but reserves specialist medicines for SM', () => {
    const allowed = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'C' }],
      { enforcePrescribingLevel: true, providerClassLevel: 'D' }
    )
    const specialistBlocked = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'SM' }],
      { enforcePrescribingLevel: true, providerClassLevel: 'D' }
    )
    const specialistAllowed = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'SM' }],
      { enforcePrescribingLevel: true, providerClassLevel: 'SM' }
    )

    expect(allowed.blockers).not.toEqual(expect.arrayContaining([
      expect.stringContaining('requires NHIS prescribing level C'),
    ]))
    expect(specialistBlocked.blockers).toContain(
      'Medicine 1: requires NHIS prescribing level SM, but this facility is configured as D. Use an authorized prescriber/facility or remove the medicine.'
    )
    expect(specialistAllowed.blockers).not.toEqual(expect.arrayContaining([
      expect.stringContaining('requires NHIS prescribing level SM'),
    ]))
  })

  it('uses the NHIS drug catalog to find prescribing level when claim medicine rows do not store it', () => {
    const readiness = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, drugCode: 'MIDAZOIN1', category: '' }],
      {
        enforcePrescribingLevel: true,
        providerClassLevel: 'B2',
        nhisDrugCatalog: [{ code: 'MIDAZOIN1', category: 'C' }],
      }
    )

    expect(readiness.blockers).toContain(
      'Medicine 1: requires NHIS prescribing level C, but this facility is configured as B2. Use an authorized prescriber/facility or remove the medicine.'
    )
  })

  it('requires provider class level before enforcing prescribing levels', () => {
    const readiness = assessNhisClaimReadiness(
      baseClaim,
      [{ ...baseMedicine, category: 'A' }],
      { enforcePrescribingLevel: true }
    )

    expect(readiness.blockers).toContain('Set the NHIA provider class/level in Settings before saving/submitting NHIS claims.')
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

describe('CLAIM-it export helpers', () => {
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
    expect(payload.claims[0].prescriptionAttachment.fileName).toBe('rx.pdf')
  })

  it('carries HMS setup details into the CLAIM-it payload and XML', () => {
    const payload = buildNhisClaimItExportPayload([claim], {
      yearMonth: '2026-05',
      organizationType: 'hospital',
      facilityCode: 'HPI0542',
      providerNumber: 'HPAH0542',
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
})

describe('direct NHIA submission', () => {
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
      claim: {
        id: 'claim-1',
        claim_number: 'NHIS-000001',
        status: 'served',
        organization_type: 'pharmacy',
        member_no: '12345678',
        surname: 'Mensah',
        other_names: 'Ama',
        patient_address: 'Accra',
        date_of_birth: '1990-01-01',
        ccc_no: 'CC-12345',
        diagnosis: 'Malaria',
        service_date_from: '2026-05-14',
        physician_name: 'Dr Test',
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
      },
      directApiSource: 'hosted',
      providerClassLevel: 'D',
      nhisDrugCatalog: [{ code: 'NH001', category: 'A' }],
    })

    expect(invokeTierAccess).toHaveBeenCalledWith(expect.objectContaining({
      action: 'submit_nhia_claims_direct',
      submissionAction: 'nhis.direct_claim_submit',
      claimIds: ['claim-1'],
    }))
  })
})

describe('validateNhisPrescriptionPdfFile', () => {
  it('accepts PDF and JPEG files and rejects other file types', () => {
    expect(validateNhisPrescriptionPdfFile({ name: 'rx.pdf', type: 'application/pdf', size: 1024 })).toBe('')
    expect(validateNhisPrescriptionPdfFile({ name: 'rx.jpg', type: 'image/jpeg', size: 1024 })).toBe('')
    expect(validateNhisPrescriptionPdfFile({ name: 'rx.png', type: 'image/png', size: 1024 })).toBe(
      'Only scanned prescription files in PDF or JPEG format can be attached.'
    )
  })

  it('enforces the 3 MB prescription attachment limit', () => {
    expect(validateNhisPrescriptionPdfFile({ name: 'rx.pdf', type: 'application/pdf', size: 4 * 1024 * 1024 })).toBe(
      'Prescription attachment must be 3 MB or smaller.'
    )
  })
})
