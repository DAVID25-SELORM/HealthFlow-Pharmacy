import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nhisPage = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')

describe('NHIS direct-serving confirmation contract', () => {
  it('shows the entered CCC alongside the final serving review details', () => {
    expect(nhisPage).toContain("<span>CCC / CC Code</span><strong>{claimForm.cccNo || 'Not entered'}</strong>")
    expect(nhisPage).toContain("<span>Member number</span><strong>{claimForm.memberNo || claimForm.hin || 'Not entered'}</strong>")
    expect(nhisPage).toContain("'Confirm & Serve Directly'")
  })
})
