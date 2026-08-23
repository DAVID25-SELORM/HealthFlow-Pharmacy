import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nhisPage = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')

describe('NHIS claims list CCC contract', () => {
  it('shows each claim CCC beside its member number and HIN for quick confirmation', () => {
    expect(nhisPage).toContain("<div className=\"patient-meta\">CCC: {c.ccc_no || '—'}</div>")
  })
})
