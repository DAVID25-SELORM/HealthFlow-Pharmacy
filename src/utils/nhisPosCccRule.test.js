import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NHIS_POS_CCC_OVERRIDE_REASON_MAX_LENGTH,
  NHIS_POS_CCC_OVERRIDE_ROLES,
  buildNhisPosCccOverrideNote,
  canOverrideNhisPosCcc,
  getNhisPosCccIssue,
  normalizeNhisPosCccOverrideReason,
} from './nhisPosCccRule'

describe('getNhisPosCccIssue (NHIS-006)', () => {
  it.each(['cashier', 'pharmacist', 'assistant', 'billing', 'technician', '', undefined])(
    'blocks an NHIS sale with no code for %s, even with a reason typed',
    (role) => {
      const issue = getNhisPosCccIssue({ cccNo: '', role, overrideReason: 'NHIA is down today' })
      expect(issue).toMatch(/required for an NHIS sale/)
      expect(issue).toMatch(/manager, admin or claims officer/)
    }
  )

  it('allows a valid 5-digit code for any role', () => {
    expect(getNhisPosCccIssue({ cccNo: '12345', role: 'cashier' })).toBe('')
    expect(getNhisPosCccIssue({ cccNo: '01234', role: 'pharmacist' })).toBe('')
    expect(getNhisPosCccIssue({ cccNo: ' 12 345 ', role: 'cashier' })).toBe('')
  })

  it('rejects a code that is not exactly 5 digits, for every role including overriders', () => {
    for (const role of ['cashier', 'admin']) {
      expect(getNhisPosCccIssue({ cccNo: '1234', role, overrideReason: 'NHIA is down today' })).toBe('CCC / CC Code must contain exactly 5 digits.')
      expect(getNhisPosCccIssue({ cccNo: '123456', role })).toBe('CCC / CC Code must contain exactly 5 digits.')
    }
  })

  it.each(NHIS_POS_CCC_OVERRIDE_ROLES)('lets %s complete without a code only with a reason', (role) => {
    expect(getNhisPosCccIssue({ cccNo: '', role, overrideReason: 'NHIA is down today' })).toBe('')
    expect(getNhisPosCccIssue({ cccNo: '', role, overrideReason: '' })).toMatch(/give a reason/)
    expect(getNhisPosCccIssue({ cccNo: '', role, overrideReason: 'ab' })).toMatch(/at least 5 characters/)
    expect(getNhisPosCccIssue({ cccNo: '', role, overrideReason: '     ' })).toMatch(/give a reason/)
  })

  it('treats the role case-insensitively but only the listed roles override', () => {
    expect(canOverrideNhisPosCcc('ADMIN')).toBe(true)
    expect(canOverrideNhisPosCcc(' Claims_Officer ')).toBe(true)
    expect(canOverrideNhisPosCcc('branch_manager')).toBe(true)
    expect(canOverrideNhisPosCcc('super_admin')).toBe(true)
    expect(canOverrideNhisPosCcc('pharmacist')).toBe(false)
    expect(canOverrideNhisPosCcc('cashier')).toBe(false)
    expect(canOverrideNhisPosCcc('assistant')).toBe(false)
    expect(canOverrideNhisPosCcc(null)).toBe(false)
  })
})

describe('override reason and note', () => {
  it('collapses whitespace and caps the reason length', () => {
    expect(normalizeNhisPosCccOverrideReason('  NHIA   down\n today  ')).toBe('NHIA down today')
    expect(normalizeNhisPosCccOverrideReason('x'.repeat(500))).toHaveLength(NHIS_POS_CCC_OVERRIDE_REASON_MAX_LENGTH)
  })

  it('writes an audit line for a no-code sale by an allowed role', () => {
    expect(buildNhisPosCccOverrideNote({ cccNo: '', role: 'Claims_Officer', overrideReason: ' NHIA  down ', actorLabel: 'Sarah Q' }))
      .toBe('CC code completed without a code at POS by claims_officer (Sarah Q). Reason: NHIA down')
    expect(buildNhisPosCccOverrideNote({ role: 'admin', overrideReason: 'NHIA is down today' }))
      .toBe('CC code completed without a code at POS by admin. Reason: NHIA is down today')
  })

  it('writes nothing when a code was entered, the role cannot override, or the reason is too short', () => {
    expect(buildNhisPosCccOverrideNote({ cccNo: '12345', role: 'admin', overrideReason: 'NHIA is down today' })).toBe('')
    expect(buildNhisPosCccOverrideNote({ cccNo: '', role: 'cashier', overrideReason: 'NHIA is down today' })).toBe('')
    expect(buildNhisPosCccOverrideNote({ cccNo: '', role: 'admin', overrideReason: 'no' })).toBe('')
  })
})

describe('point-of-sale wiring (source check)', () => {
  const sales = readFileSync(resolve(process.cwd(), 'src/pages/Sales.jsx'), 'utf8')

  it('uses the rule before the sale is confirmed or any write happens', () => {
    const importIndex = sales.indexOf("from '../utils/nhisPosCccRule'")
    const checkIndex = sales.indexOf('getNhisPosCccIssue({ cccNo: nhiaCccNo, role, overrideReason: nhiaCccOverrideReason })')
    const confirmIndex = sales.indexOf('setShowSaleConfirmation(true)')

    expect(importIndex).toBeGreaterThan(-1)
    expect(checkIndex).toBeGreaterThan(-1)
    expect(confirmIndex).toBeGreaterThan(checkIndex)
  })

  it('no longer accepts a blank code for claims-officer review', () => {
    expect(sales).not.toContain('or be left blank for claims-officer review')
    expect(sales).not.toContain('Optional — required before export')
  })

  it('records the override reason on the review claim notes', () => {
    expect(sales).toContain('buildNhisPosCccOverrideNote(')
  })

  it('clears the override reason wherever the code is cleared', () => {
    // The only direct clear is inside clearNhiaCccFields itself; every other place calls it.
    expect(sales.match(/setNhiaCccNo\(''\)/g) || []).toHaveLength(1)
    expect((sales.match(/clearNhiaCccFields\(\)/g) || []).length).toBeGreaterThanOrEqual(7)
  })
})
