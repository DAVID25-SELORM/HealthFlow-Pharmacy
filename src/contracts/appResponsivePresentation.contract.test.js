import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')

const criticalPageStyles = [
  'src/pages/Inventory.css',
  'src/pages/Sales.css',
  'src/pages/Reports.css',
  'src/pages/Settings.css',
  'src/pages/Nhis.css',
  'src/pages/Patients.css',
  'src/pages/Claims.css',
  'src/pages/Purchases.css',
  'src/pages/Accounting.css',
]

describe('application responsive presentation', () => {
  it.each(criticalPageStyles)('%s retains a phone breakpoint', (path) => {
    expect(read(path)).toMatch(/@media\s*\(max-width:\s*(?:7[0-9]{2}|6[0-9]{2}|5[0-9]{2}|4[0-9]{2}|3[0-9]{2})px\)/)
  })

  it('keeps the application shell fluid when the sidebar collapses', () => {
    const layout = read('src/components/Layout/Layout.css')
    expect(layout).toMatch(/@media\s*\(max-width:\s*1024px\)[\s\S]*?\.main-content\s*\{[\s\S]*?margin-left:\s*0;[\s\S]*?width:\s*100%;/)
  })

  it('stacks shared header actions on narrow phones', () => {
    const globalStyles = read('src/index.css')
    const narrowPhoneStart = globalStyles.lastIndexOf('@media (max-width: 480px)')
    const narrowPhoneRules = globalStyles.slice(narrowPhoneStart)
    expect(narrowPhoneRules).toMatch(/\.header-actions\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/)
    expect(narrowPhoneRules).toMatch(/\.header-actions > \.btn,[\s\S]*?width:\s*100%;/)
  })
})
