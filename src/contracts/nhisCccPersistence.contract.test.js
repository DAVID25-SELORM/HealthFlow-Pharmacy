import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nhisPage = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')
const salesPage = readFileSync(resolve(process.cwd(), 'src/pages/Sales.jsx'), 'utf8')

describe('NHIS CCC persistence contract', () => {
  it('does not erase a manually entered CCC when automatic NHIA validation is unavailable or pending', () => {
    expect(nhisPage).not.toContain("setClaimForm((prev) => ({ ...prev, cccNo: '' }))")
    expect(nhisPage).not.toContain("setClaimForm((prev) => ({ ...prev, cccNo: '', ccCode: '' }))")
  })

  it('allows a CCC captured at NHIA POS checkout to be copied to the review claim', () => {
    expect(salesPage).toContain('const [nhiaCccNo, setNhiaCccNo] = useState(\'\')')
    expect(salesPage).toContain('cccNo: normalizeNhisCcCode(nhiaCccNo).slice(0, 5)')
    expect(salesPage).toContain('id="nhia-ccc-no"')
    expect(salesPage).toContain("CCC / CC Code must contain exactly 5 digits, or be left blank for claims-officer review.")
  })
})
