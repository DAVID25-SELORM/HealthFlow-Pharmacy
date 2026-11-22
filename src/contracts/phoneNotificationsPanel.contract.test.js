import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/components/Layout/TopBar.css'), 'utf8').replace(/\r\n/g, '\n')

describe('notifications panel on phones', () => {
  it('spans the screen under the top bar instead of hanging off the bell', () => {
    const phoneBlock = css.match(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\n\}/)?.[0] || ''
    expect(phoneBlock).toMatch(/\.topbar-alerts\s*\{\s*position:\s*static;/)
    expect(phoneBlock).toMatch(/\.alerts-panel\s*\{[\s\S]*?left:\s*0\.75rem;[\s\S]*?right:\s*0\.75rem;[\s\S]*?width:\s*auto;/)
    expect(phoneBlock).toMatch(/\.alerts-panel\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto;/)
  })
})
