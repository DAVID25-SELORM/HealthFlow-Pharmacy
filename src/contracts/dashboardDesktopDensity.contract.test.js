import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const dashboardCss = readFileSync(resolve(process.cwd(), 'src/pages/Dashboard.css'), 'utf8')

describe('dashboard desktop density', () => {
  it('removes repeated decorative and module-status details from the main scan path', () => {
    const redesignStart = dashboardCss.indexOf('Compact redesign pass')
    const responsiveStart = dashboardCss.indexOf('@media (max-width: 1180px)', redesignStart)
    const desktopRules = dashboardCss.slice(redesignStart, responsiveStart)

    expect(desktopRules).toMatch(
      /\.hero-eyebrow,[\s\S]*\.hero-feature-pills,[\s\S]*\.hero-panel-card-hint\s*\{\s*display:\s*none;/
    )
  })

  it('uses a readable three-column cash summary instead of six compressed columns', () => {
    const redesignStart = dashboardCss.indexOf('Compact redesign pass')
    const responsiveStart = dashboardCss.indexOf('@media (max-width: 1180px)', redesignStart)
    const desktopRules = dashboardCss.slice(redesignStart, responsiveStart)

    expect(desktopRules).toMatch(
      /\.cash-inflow-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s
    )
  })
})
