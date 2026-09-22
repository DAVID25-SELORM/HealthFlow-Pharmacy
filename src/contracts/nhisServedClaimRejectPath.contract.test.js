// A served claim with recorded stock movements cannot be deleted (the database
// deliberately blocks that to protect inventory history). Before this fix there was
// no other way to get such a claim out of the active list, so admins had no path
// forward. Reject now covers that case too, and the delete error is explained.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/pages/Nhis.jsx', 'utf8').replace(/\r\n/g, '\n')

describe('served claim reject path', () => {
  it('offers Reject on a served claim, gated on the same permission as Delete', () => {
    expect(source).toContain("c.status === 'served' && canDeleteNhisClaims && (")
    const block = source.slice(
      source.indexOf("c.status === 'served' && canDeleteNhisClaims && ("),
      source.indexOf("c.status === 'served' && canDeleteNhisClaims && (") + 600,
    )
    expect(block).toContain("onClick={() => { setRejectTarget(c); setRejectReason('') }}")
  })

  it('turns the raw database block into a message that points to Reject', () => {
    expect(source).toMatch(/recorded inventory movements\|inventory policy baseline/)
    expect(source).toMatch(/Use Reject on this claim instead/)
    expect(source).toContain('getClaimDeleteBlockedMessage(err, claim)')
  })
})
