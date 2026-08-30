import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const inventoryPage = readFileSync(resolve(process.cwd(), 'src/pages/Inventory.jsx'), 'utf8')
const inventoryCss = readFileSync(resolve(process.cwd(), 'src/pages/Inventory.css'), 'utf8')

describe('inventory mobile layout contract', () => {
  it('keeps every paginated desktop row reachable through an explicit table scrollbar', () => {
    expect(inventoryCss).toContain('.inventory-page .table-container {')
    expect(inventoryCss).toContain('overflow: auto;')
    expect(inventoryCss).toContain('.inventory-page .table-container::-webkit-scrollbar')
    expect(inventoryCss).toContain('scrollbar-gutter: stable;')
  })

  it('uses the existing inventory data as labelled cards on mobile', () => {
    expect(inventoryPage).toContain('data-label="Medicine"')
    expect(inventoryPage).toContain('data-label="Selling price"')
    expect(inventoryCss).toContain('.inventory-table td::before')
    expect(inventoryCss).toContain('content: attr(data-label);')
    expect(inventoryCss).toContain('.inventory-table thead {\n    display: none;')
  })

  it('paginates the complete filtered medicine list with mobile-friendly navigation', () => {
    expect(inventoryPage).toContain('const INVENTORY_PAGE_SIZE = 25')
    expect(inventoryPage).toContain('const paginatedDrugs = visibleDrugs.slice(')
    expect(inventoryPage).toContain('paginatedDrugs.map((drug) =>')
    expect(inventoryPage).toContain('Page {safeCurrentPage} of {totalPages}')
    expect(inventoryPage).toContain('Previous')
    expect(inventoryPage).toContain('Next')
    expect(inventoryCss).toContain('.inventory-page .page-current')
  })

  it('shows and distinguishes both regular and NHIS medication catalogues', () => {
    expect(inventoryPage).toContain('includeCatalog: true')
    expect(inventoryPage).toContain("value: 'regular_catalog'")
    expect(inventoryPage).toContain("value: 'nhis_catalog'")
    expect(inventoryPage).toContain("return 'Regular catalogue'")
    expect(inventoryPage).toContain("return 'NHIS catalogue'")
    expect(inventoryPage).toContain('void repairDefaultCatalog(defaultBranchId)')
  })
})
