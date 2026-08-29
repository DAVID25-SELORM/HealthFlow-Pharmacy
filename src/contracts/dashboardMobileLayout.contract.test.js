import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const dashboardCss = readFileSync(resolve(process.cwd(), 'src/pages/Dashboard.css'), 'utf8')

describe('dashboard mobile layout', () => {
  it('reapplies the single-column hero after the compact desktop redesign', () => {
    const redesignStart = dashboardCss.indexOf('Compact redesign pass')
    const responsiveStart = dashboardCss.indexOf('@media (max-width: 1180px)', redesignStart)
    const phoneStart = dashboardCss.indexOf('@media (max-width: 760px)', responsiveStart)
    const tabletRules = dashboardCss.slice(responsiveStart, phoneStart)

    expect(responsiveStart).toBeGreaterThan(redesignStart)
    expect(tabletRules).toMatch(/\.dashboard-hero\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s)
  })

  it('allows dashboard cards and their content to shrink within a phone viewport', () => {
    const phoneStart = dashboardCss.lastIndexOf('@media (max-width: 760px)')
    const narrowPhoneStart = dashboardCss.indexOf('@media (max-width: 420px)', phoneStart)
    const phoneRules = dashboardCss.slice(phoneStart, narrowPhoneStart)

    expect(phoneRules).toContain('.hero-copy,')
    expect(phoneRules).toContain('min-width: 0;')
    expect(phoneRules).toContain('width: 100%;')
    expect(phoneRules).toContain('overflow-wrap: anywhere;')
  })

  it('reduces secondary dashboard detail instead of crowding the phone viewport', () => {
    const phoneStart = dashboardCss.lastIndexOf('@media (max-width: 760px)')
    const phoneRules = dashboardCss.slice(phoneStart)

    expect(phoneRules).toMatch(/\.hero-action-description,[\s\S]*\.hero-feature-pills[\s\S]*display:\s*none;/)
    expect(phoneRules).toMatch(/\.hero-panel-grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s)
    expect(phoneRules).toMatch(/\.hero-actions,[\s\S]*\.dashboard \.stats-grid,[\s\S]*\.cash-inflow-grid[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/)
  })
})
