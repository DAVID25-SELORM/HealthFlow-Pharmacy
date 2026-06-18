import { describe, expect, it } from 'vitest'
import {
  canContinueNhisReturnAlert,
  findNhisPatientReturnAlert,
  normalizeNhisReturnAlertSettings,
} from './nhisReturnAlert'

const recentClaim = {
  id: 'claim-prev',
  claim_number: 'NHIS-000010',
  member_no: '99441270',
  hin: 'HIN-1',
  surname: 'OKYERE',
  other_names: 'FRANK',
  service_date_from: '2026-06-16T07:30:00.000Z',
  branch_id: 'KORLE BU',
  status: 'served',
  created_by: 'user-1',
  nhis_claim_medicines: [
    { drug_code: 'PARA500', description: 'Paracetamol Tablet', dispensed_qty: 10 },
  ],
}

describe('NHIS patient return alert', () => {
  it('finds a return visit within the configured window by NHIS member number', () => {
    const alert = findNhisPatientReturnAlert({
      currentPatient: { memberNo: '99441270' },
      currentMedicines: [{ drugCode: 'AMOX500', description: 'Amoxicillin', dispensedQty: 12 }],
      claims: [recentClaim],
      now: '2026-06-16T10:00:00.000Z',
      settings: { nhisReturnAlertWindowHours: 6 },
    })

    expect(alert).toMatchObject({
      previousClaim: expect.objectContaining({ id: 'claim-prev' }),
      matchType: 'NHIS membership number',
      hoursSincePrevious: 2.5,
      sameMedicationRepeated: false,
    })
    expect(alert.currentMedicines[0]).toMatchObject({ name: 'Amoxicillin', quantity: 12 })
  })

  it('still alerts when the new medicine is different', () => {
    const alert = findNhisPatientReturnAlert({
      currentPatient: { hin: 'HIN-1' },
      currentMedicines: [{ drugCode: 'CIPRO1', description: 'Ciprofloxacin', dispensedQty: 5 }],
      claims: [recentClaim],
      now: '2026-06-16T11:00:00.000Z',
    })

    expect(alert).toBeTruthy()
    expect(alert.sameMedicationRepeated).toBe(false)
  })

  it('marks repeated medicine separately from the return alert', () => {
    const alert = findNhisPatientReturnAlert({
      currentPatient: { hin: 'HIN-1' },
      currentMedicines: [{ drugCode: 'PARA500', description: 'Paracetamol Tablet', dispensedQty: 4 }],
      claims: [recentClaim],
      now: '2026-06-16T11:00:00.000Z',
    })

    expect(alert).toBeTruthy()
    expect(alert.sameMedicationRepeated).toBe(true)
    expect(alert.repeatedMedicines).toHaveLength(1)
  })

  it('describes pending MCA claims as prescribed medicines awaiting serving', () => {
    const alert = findNhisPatientReturnAlert({
      currentPatient: { hin: 'HIN-1' },
      currentMedicines: [{ drugCode: 'AMOX500', description: 'Amoxicillin', dispensedQty: 5 }],
      claims: [
        {
          ...recentClaim,
          status: 'pending_serving',
          nhis_claim_medicines: [
            {
              drug_code: 'PARA500',
              description: 'Paracetamol Tablet',
              prescribed_qty: 30,
              served_qty: 0,
              serving_status: 'pending',
            },
          ],
        },
      ],
      now: '2026-06-16T11:00:00.000Z',
    })

    expect(alert).toMatchObject({
      previousVisitIsPendingServing: true,
      previousMedicineHeading: 'Prescribed medicines awaiting MCA',
      previousMedicineEmptyMessage: 'No prescribed medicines recorded on the pending claim.',
      previousUserLabel: 'Created by',
    })
    expect(alert.previousVisitMessage).toContain('awaiting MCA serving')
    expect(alert.previousMedicines[0]).toMatchObject({
      name: 'Paracetamol Tablet',
      prescribedQuantity: 30,
      servedQuantity: 0,
      servingStatus: 'pending',
    })
  })

  it('uses phone as fallback only when no stronger identifier exists', () => {
    const alert = findNhisPatientReturnAlert({
      currentPatient: { phone: '024 123 4567' },
      claims: [{ ...recentClaim, hin: '', member_no: '', phone: '+233241234567' }],
      now: '2026-06-16T08:30:00.000Z',
    })

    expect(alert).toMatchObject({ matchType: 'phone' })
  })

  it('does not alert outside the configured window', () => {
    const alert = findNhisPatientReturnAlert({
      currentPatient: { memberNo: '99441270' },
      claims: [recentClaim],
      now: '2026-06-17T10:00:00.000Z',
      settings: { nhisReturnAlertWindowHours: 24 },
    })

    expect(alert).toBeNull()
  })

  it('normalizes settings and role continuation rules', () => {
    const settings = normalizeNhisReturnAlertSettings({
      nhis_return_alert_window_hours: 12,
      nhis_return_alert_allowed_roles: ['admin', 'claims_officer'],
    })

    expect(settings).toMatchObject({
      enabled: true,
      windowHours: 12,
      requireReason: true,
      allowedRoles: ['admin', 'claims_officer'],
    })
    expect(canContinueNhisReturnAlert('claims_officer', settings)).toBe(true)
    expect(canContinueNhisReturnAlert('assistant', settings)).toBe(false)
  })
})
