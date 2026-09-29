import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Purchases.jsx is too large to mount in these tests; these pin the wiring that keeps bulk import strictly a draft-
// only convenience: it must never call the stock-changing RPC, and manual entry must remain fully intact alongside it.
const source = readFileSync('src/pages/Purchases.jsx', 'utf8').replace(/\r\n/g, '\n')

describe('Purchase order bulk import wiring', () => {
  it('adds a Manual Entry / Import Excel/CSV toggle without removing the manual entry panel', () => {
    expect(source).toContain('Manual Entry')
    expect(source).toContain('Import Excel/CSV')
    expect(source).toContain("itemEntryMode === 'manual'")
    expect(source).toContain("itemEntryMode === 'import'")
    // the original manual fields are all still present and still call the original addLineItem
    expect(source).toContain('<label>Drug / Item *</label>')
    expect(source).toContain('onClick={addLineItem}')
  })

  it('imported rows only ever join the same lineItems state manual entry writes to', () => {
    const handler = source.slice(source.indexOf('const handleImportItems'), source.indexOf('const handleImportItems') + 700)
    expect(handler).toContain('setLineItems((prev) => [...prev, ...items])')
    // it must never call the purchase-completion/receiving RPC path
    expect(handler).not.toContain('completePurchase')
    expect(handler).not.toContain('complete_purchase')
    expect(handler).not.toContain('receivePurchaseGoods')
  })

  it('logs an import audit event only with counts, not per row, and never blocks the draft on a logging failure', () => {
    const handler = source.slice(source.indexOf('const handleImportItems'), source.indexOf('const handleImportItems') + 700)
    expect(handler).toContain("eventType: 'purchase.items_imported'")
    expect(handler).toContain('valid_rows: summary?.validRows')
    expect(handler).toContain('tryLogAuditEvent(') // best-effort helper, not awaited/thrown on failure
    expect(handler).not.toContain('await tryLogAuditEvent(')
  })

  it('resets the import tab back to Manual Entry when the purchase modal is reset', () => {
    const resetModal = source.slice(source.indexOf('const resetModal'), source.indexOf('const resetModal') + 400)
    expect(resetModal).toContain("setItemEntryMode('manual')")
  })

  it('passes the page’s own unit list and calculators into the import panel (no second calculation path)', () => {
    expect(source).toContain('allowedUnits={unitOptions.map((option) => option.value)}')
    expect(source).toContain('calcDiscountValue={calcDiscountValue}')
    expect(source).toContain('calcNetTotal={calcNetTotal}')
  })
})

describe('createPurchase / completePurchase remain the only place stock changes', () => {
  const purchasesService = readFileSync('src/services/purchasesService.js', 'utf8').replace(/\r\n/g, '\n')

  const createFnStart = purchasesService.indexOf('export const createPurchase')
  const createFn = purchasesService.slice(createFnStart, createFnStart + 3000)

  it('createPurchase always saves as a draft', () => {
    expect(createFn).toContain("status: 'draft'")
    expect(createFn).toContain("status:         'draft'")
  })

  it('stock changes go through the complete_purchase RPC call, not createPurchase', () => {
    expect(createFn).not.toContain("rpc('complete_purchase'")
    expect(purchasesService).toContain("rpc('complete_purchase'")
  })
})
