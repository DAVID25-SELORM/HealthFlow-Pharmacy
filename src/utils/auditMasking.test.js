import { describe, expect, it } from 'vitest'
import { maskAuditPersonalData } from './auditMasking'

describe('audit personal data masking', () => {
  it('keeps only the last three characters of phone, member and card numbers', () => {
    const masked = maskAuditPersonalData({
      phone: '0247654381',
      patient_phone: '+233247654381',
      member_no: 'GHA-123456789',
      member_number: '12345678',
      ghana_card_number: 'GHA-000000000-1',
      hin: '987654321',
    })
    expect(masked).toEqual({
      phone: '*******381',
      patient_phone: '**********381',
      member_no: '**********789',
      member_number: '*****678',
      ghana_card_number: '************0-1',
      hin: '******321',
    })
  })

  it('removes clinical and contact free text completely', () => {
    const masked = maskAuditPersonalData({
      diagnosis_details: 'Type 2 diabetes',
      clinical_notes: 'allergic to penicillin',
      notes: 'call back',
      address: '12 Some Street',
      date_of_birth: '1980-01-01',
    })
    expect(Object.values(masked)).toEqual(Array(5).fill('[REDACTED]'))
  })

  it('leaves the details an audit review needs untouched', () => {
    const details = {
      patient_name: 'Ama Mensah',
      full_name: 'Kofi Boateng',
      claim_number: 'CL-0001',
      status: 'served',
      card_type: 'NHISCARD',
      patient_record_updated: true,
      active_role: 'pharmacist',
      count: 3,
    }
    expect(maskAuditPersonalData(details)).toEqual(details)
  })

  it('reaches inside nested old/new value snapshots and lists', () => {
    const masked = maskAuditPersonalData({
      old_value: { status: 'draft', member_no: '123456789' },
      new_value: { status: 'served', member_no: '123456789', notes: 'x' },
      rows: [{ phone: '0201234567' }],
    })
    expect(masked.old_value).toEqual({ status: 'draft', member_no: '******789' })
    expect(masked.new_value).toEqual({ status: 'served', member_no: '******789', notes: '[REDACTED]' })
    expect(masked.rows).toEqual([{ phone: '*******567' }])
  })

  it('does not touch empty values, booleans or already masked values', () => {
    expect(maskAuditPersonalData({ phone: '', member_no: null, address: undefined })).toEqual({
      phone: '',
      member_no: null,
      address: undefined,
    })
    expect(maskAuditPersonalData({ phone_updated: true })).toEqual({ phone_updated: true })
    expect(maskAuditPersonalData({ phone: '*******381' })).toEqual({ phone: '*******381' })
  })

  it('passes non-objects straight through', () => {
    expect(maskAuditPersonalData(null)).toBeNull()
    expect(maskAuditPersonalData('text')).toBe('text')
  })
})
