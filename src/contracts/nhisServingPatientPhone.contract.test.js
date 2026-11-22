import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')

describe('NHIS serving form patient telephone', () => {
  const page = read('src/pages/Nhis.jsx')
  const service = read('src/services/nhisService.js')

  it('has an optional telephone box on the claim form', () => {
    expect(page).toMatch(/id="nhis-patient-phone"[\s\S]{0,200}type="tel"/)
    expect(page).not.toMatch(/id="nhis-patient-phone"[\s\S]{0,400}required/)
  })

  it('saves the number as its own step after the claim, and never blocks the claim', () => {
    const afterSave = page.slice(page.indexOf('const savedClaimId = savedClaimRecord'))
    expect(afterSave).toMatch(/saveNhisClaimPatientPhone\(savedClaimId, phoneToSave/)
    expect(afterSave).toMatch(/catch \(phoneError\)[\s\S]{0,200}phoneSaveNote =/)
  })

  it('keeps the telephone out of the normal claim save and correction payloads', () => {
    const payloadStart = service.indexOf('export const createNhisClaim')
    const payloadEnd = service.indexOf('export const getNhisClaimCorrectionHistory')
    expect(service.slice(payloadStart, payloadEnd)).not.toMatch(/patient_phone|patientPhone/)
  })

  it('fills from the latest earlier claim without overwriting a typed number', () => {
    expect(page).toMatch(/setClaimForm\(\(prev\) => \(prev\.patientPhone \? prev : \{ \.\.\.prev, patientPhone: found \}\)\)/)
  })

  it('adds only a nullable column in the migration', () => {
    const sql = read('supabase/migrations/20261122090000_add_nhis_claim_patient_phone.sql')
    expect(sql).toMatch(/add column if not exists patient_phone text;/)
    expect(sql).not.toMatch(/not null|drop |delete |update /i)
  })
})
