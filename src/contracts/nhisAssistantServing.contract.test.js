import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')

describe('NHIS dispensary assistant serving workflow', () => {
  it('does not open an empty claim for serving', () => {
    expect(source).toContain('isMedicineCounterAssistant && compactMedicines(claim.nhis_claim_medicines).length === 0')
    expect(source).toContain('No prescribed medicines are available to serve.')
    expect(source).toContain('Ask the Claims Officer to add the medicine and send the claim to the dispensary again.')
  })

  it('does not request NHIS catalogue repair under the Assistant role', () => {
    expect(source).toContain("const canRepairNhisCatalog = canWrite && normalizedRole !== 'assistant'")
    expect(source).toContain('canRepairNhisCatalog &&\n        DEFAULT_NHIS_DRUG_CATALOG.length > 0')
  })
})
