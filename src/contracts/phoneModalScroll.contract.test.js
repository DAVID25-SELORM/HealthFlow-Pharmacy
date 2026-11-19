import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

// Returns the text of the first @media block that starts with `header` (brace-balanced).
const mediaBlock = (css, header) => {
  const start = css.indexOf(header)
  expect(start, `missing ${header}`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') depth -= 1
    if (depth === 0) return css.slice(start, i + 1)
  }
  throw new Error(`unterminated ${header}`)
}

// On phones the two-pane modals become one scrolling column. If the rows are left to shrink to
// the modal height, the first pane spills out of its box and the second pane paints over it
// (the CCC code and its Generate/Validate button disappear), so each row must size to its content.
describe('phone modal scrolling', () => {
  it('sizes the NHIS claim panes to their content on phones', () => {
    const block = mediaBlock(read('src/pages/Nhis.css'), '@media (max-width: 920px)')
    expect(block).toMatch(/\.nhis-claim-body\s*\{[^}]*grid-auto-rows:\s*max-content/)
  })

  it('sizes the purchase modal panes to their content on phones', () => {
    const block = mediaBlock(read('src/pages/Purchases.css'), '@media (max-width: 768px)')
    expect(block).toMatch(/\.purchase-modal-body\s*\{[^}]*grid-auto-rows:\s*max-content/)
    expect(block).toMatch(/\.purchase-modal-left\s*\{[^}]*overflow:\s*visible/)
  })
})
