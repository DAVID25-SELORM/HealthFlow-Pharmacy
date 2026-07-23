import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const functionSourcePath = path.resolve('supabase/functions/tier-access/index.ts')

const extractArrayLiteral = (source, name) => {
  const pattern = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]\\.join`)
  const match = source.match(pattern)
  if (!match) throw new Error(`${name} not found`)
  return match[1]
}

describe('tier-access patient workspace compatibility', () => {
  it('only selects columns that belong to the live patients table', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const patientSelect = extractArrayLiteral(source, 'PATIENT_WORKSPACE_PATIENT_SELECT_FIELDS')

    expect(patientSelect).not.toContain("'branch_id'")
    expect(patientSelect).not.toContain("'folder_no'")
    expect(patientSelect).not.toContain("'last_visit_at'")
    expect(patientSelect).not.toContain("'nhis_member_no'")
    expect(patientSelect).not.toContain("'nhis_hin'")
    expect(patientSelect).toContain("'organization_id'")
    expect(patientSelect).toContain("'full_name'")
    expect(patientSelect).toContain("'insurance_id'")
  })
})
