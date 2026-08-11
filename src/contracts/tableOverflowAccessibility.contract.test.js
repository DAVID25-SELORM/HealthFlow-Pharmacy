import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const globalCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

describe('application-wide wide-table accessibility', () => {
  it('keeps both table axes reachable within the viewport across shared and page-specific wrappers', () => {
    const rule = globalCss.slice(
      globalCss.indexOf('[class*="table-wrap"]'),
      globalCss.indexOf('.modal-overlay')
    )

    expect(rule).toContain('[class*="table-wrapper"]')
    expect(rule).toContain('.table-container')
    expect(rule).toContain('.hf-table-scroll')
    expect(rule).toContain('max-height: min(42rem, 62dvh)')
    expect(rule).toContain('overflow: auto')
  })

  it('keeps table headers visible while users scroll inside a long wide table', () => {
    expect(globalCss).toContain('[class*="table-wrap"] table thead th')
    expect(globalCss).toContain('position: sticky')
  })
})
