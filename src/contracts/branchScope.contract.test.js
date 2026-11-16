import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')

// BRANCH-001: every place that shows a branch member of staff stock, sales or stock alerts passes the
// branch scope, so a newly created branch never shows the main store's stock or sales.
describe('branch staff see their own branch only (BRANCH-001)', () => {
  it('limits the dashboard sales and stock alerts', () => {
    const dashboard = read('src/pages/Dashboard.jsx')
    expect(dashboard).toContain('const branchScopeId = useBranchScope()')
    expect(dashboard).toContain('tierLimits.hasClaims, branchScopeId]')
    expect(dashboard).toContain('branchId: branchScopeId || undefined')
    expect(dashboard).toContain('getRecentSales(5, { branchId: branchScopeId })')
    expect(dashboard).toContain('getLowStockDrugs({ branchId: branchScopeId })')
    expect(dashboard).toContain('getExpiringDrugs({ branchId: branchScopeId })')
  })

  it('limits the alert bell in the top bar', () => {
    const topBar = read('src/components/Layout/TopBar.jsx')
    expect(topBar).toContain('const branchScopeId = useBranchScope()')
    expect(topBar).toContain('getLowStockDrugs({ branchId: branchScopeId })')
    expect(topBar).toContain('getExpiringDrugs({ branchId: branchScopeId })')
  })

  it('limits the till recent sales, which carry the refund buttons', () => {
    const sales = read('src/pages/Sales.jsx')
    expect(sales.match(/getPosRecentSales\(RECENT_SALES_LIMIT, \{/g) || []).toHaveLength(2)
    expect(sales).toContain('branchId: branchScopeId')
    expect(sales).toContain('getPosRecentSales(RECENT_SALES_LIMIT, { branchId: branchScopeId })')
  })

  it('limits the NHIS medicine list, which is read straight from the stock table', () => {
    const nhis = read('src/pages/Nhis.jsx')
    expect(nhis).toContain('branchId: branchScopeId || undefined')
    expect(nhis).toContain('preferDirectRead: true')
  })

  it('uses the same hook in the till, the NHIS page and Inventory', () => {
    for (const path of ['src/pages/Sales.jsx', 'src/pages/Nhis.jsx', 'src/pages/Inventory.jsx']) {
      expect(read(path)).toContain('useBranchScope()')
    }
  })

  it('does not scope administrators, a single-branch pharmacy or a pharmacy without Multi-branch', () => {
    const scope = read('src/utils/branchScope.js')
    expect(scope).toContain('activeBranchCount <= 1')
    expect(scope).toContain("['admin', 'super_admin']")
    expect(scope).toContain('if (!multiBranchEnabled) return')
  })
})
