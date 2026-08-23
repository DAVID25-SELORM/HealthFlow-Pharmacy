import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const claimsCss = readFileSync(resolve(process.cwd(), 'src/pages/Claims.css'), 'utf8')

describe('claims mobile layout contract', () => {
  it('turns the existing claim table into labelled record cards on phones', () => {
    expect(claimsCss).toContain('.claims-table thead {\n    display: none;')
    expect(claimsCss).toContain('.claims-table td::before')
    expect(claimsCss).toContain("content: 'Claim number';")
    expect(claimsCss).toContain('grid-template-columns: minmax(7.5rem, 40%) minmax(0, 1fr);')
  })

  it('keeps status tabs reachable without forcing a vertical control stack', () => {
    expect(claimsCss).toContain('.claims-tabs {\n    flex-wrap: nowrap;\n    overflow-x: auto;')
    expect(claimsCss).toContain('.claims-page .tab-btn {\n    flex: 0 0 auto;')
  })
})
