import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')

describe('premium navigation shell', () => {
  it('shows the bottom bar and More sheet only on phones', () => {
    const css = read('src/components/Layout/BottomNav.css')
    expect(css).toMatch(/^\.bottom-nav,\s*\.bottom-sheet-layer\s*\{\s*display:\s*none;/m)
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.bottom-nav\s*\{[\s\S]*?position:\s*fixed/)
  })

  it('keeps page content clear of the bottom bar on every phone width', () => {
    const layout = read('src/components/Layout/Layout.css')
    const phoneBlocks = layout.match(/@media\s*\(max-width:\s*(?:768|640|380)px\)\s*\{[\s\S]*?\n\}/g) || []
    expect(phoneBlocks).toHaveLength(3)
    for (const block of phoneBlocks) {
      expect(block).toMatch(/calc\(5\.5rem \+ env\(safe-area-inset-bottom/)
    }
  })

  it('sizes the content from the sidebar width so the icon rail gives the room back', () => {
    const layout = read('src/components/Layout/Layout.css')
    expect(layout).toMatch(/\.app-layout\.sidebar-collapsed\s*\{\s*--sidebar-width:\s*88px;/)
    expect(layout).toMatch(/\.main-content\s*\{[\s\S]*?margin-left:\s*var\(--sidebar-width\)/)
  })

  it('removes the phone menu button now that the bottom bar replaces the drawer', () => {
    const topBar = read('src/components/Layout/TopBar.css')
    expect(topBar).toMatch(/@media\s*\(max-width:\s*768px\)\s*\{\s*\.topbar-menu-btn\s*\{\s*display:\s*none;/)
  })

  it('takes both menus from one list so permissions cannot drift apart', () => {
    const sidebar = read('src/components/Layout/Sidebar.jsx')
    const bottomNav = read('src/components/Layout/BottomNav.jsx')
    expect(sidebar).toContain("from './useNavigationItems'")
    expect(bottomNav).toContain("from './useNavigationItems'")
    expect(read('src/components/Layout/useNavigationItems.js')).toContain('hasRole(role, item.roles) || item.allow')
  })
})
