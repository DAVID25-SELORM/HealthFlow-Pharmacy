import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const salesCss = readFileSync(resolve(process.cwd(), 'src/pages/Sales.css'), 'utf8')

describe('sales POS mobile layout contract', () => {
  it('keeps the POS mode switcher and branch-server actions touch friendly', () => {
    expect(salesCss).toContain('.pos-mode-toggle button {\n    flex: 1 1 0;\n    min-height: 42px;')
    expect(salesCss).toContain('.branch-server-panel {\n    align-items: stretch;\n    flex-direction: column;')
    expect(salesCss).toContain('.branch-server-actions .btn {\n    flex: 1 1 130px;\n    min-height: 42px;')
  })

  it('uses compact, readable checkout controls on phones', () => {
    expect(salesCss).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(salesCss).toContain('.payment-btn:last-child {\n    grid-column: span 2;')
    expect(salesCss).toContain('grid-template-columns: minmax(0, 1fr) auto 40px;')
  })

  it('falls back to a single column without horizontal overflow on very narrow phones', () => {
    expect(salesCss).toContain('@media (max-width: 380px)')
    expect(salesCss).toContain('.payment-btn:last-child {\n    grid-column: auto;')
    expect(salesCss).toContain('.item-controls {\n    grid-template-columns: 1fr;\n    align-items: stretch;')
  })
})
