import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const topBarCss = readFileSync(resolve(process.cwd(), 'src/components/Layout/TopBar.css'), 'utf8')
const topBarSource = readFileSync(resolve(process.cwd(), 'src/components/Layout/TopBar.jsx'), 'utf8')

describe('top bar mobile density', () => {
  it('keeps the connection meaning accessible while showing an icon-only phone control', () => {
    expect(topBarSource).toContain('<span className="connection-status-label">{connectionLabel}</span>')

    const phoneStart = topBarCss.lastIndexOf('@media (max-width: 430px)')
    const phoneRules = topBarCss.slice(phoneStart)
    expect(phoneRules).toMatch(/\.connection-status\s*\{[^}]*width:\s*36px/s)
    expect(phoneRules).toMatch(/\.connection-status-label\s*\{[^}]*clip:\s*rect\(0, 0, 0, 0\)/s)
  })
})
