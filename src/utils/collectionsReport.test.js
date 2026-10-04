// @vitest-environment node
import { it, expect } from 'vitest'
import { collectionsReport, collectionsCsv } from './collectionsReport'
const data={ invoices:[{id:'i',organization_id:'a',facility:'A',kind:'subscription',period:'2026-01-01',paid_at:'2026-02-01'},{id:'j',organization_id:'a',facility:'A',kind:'onboarding',period:'2026-01-01',amount:50,paid_at:null},{id:'k',organization_id:'b',facility:'B',kind:'subscription',amount:40}],payments:[{id:'1',invoice_id:'i',status:'approved',amount:10.10,received_on:'2026-01-01',reviewed_at:'2026-02-01',transaction_reference:'REF'},{id:'2',invoice_id:'j',status:'pending',amount:50,submitted_at:'2026-01-31'},{id:'3',invoice_id:'j',status:'rejected',amount:50,submitted_at:'2026-01-02'},{id:'4',invoice_id:'k',status:'approved',amount:40,reviewed_at:'2026-02-02'}]}
it('separates approved receipts from pending and rejected, using inclusive receipt dates',()=>{
 const r=collectionsReport(data,'a','2026-01-01','2026-01-31')
 expect(r.received).toBe(1010);expect(r.subscription).toBe(1010);expect(r.onboarding).toBe(0);expect(r.pending).toBe(5000);expect(r.outstanding).toBe(5000);expect(r.rows).toHaveLength(3)
 expect(collectionsReport(data,'a','2026-02-01').received).toBe(0)
 expect(collectionsReport(data,'b').received).toBe(4000)
})
it('sums multiple allocations once and categorizes onboarding',()=>{
 const r=collectionsReport({...data,payments:[...data.payments,{id:'5',invoice_id:'j',status:'approved',amount:20,received_on:'2026-01-03',receipt_reference:'REF'}]})
 expect(r.received).toBe(7010);expect(r.onboarding).toBe(2000)
})
it('exports exact amounts, escapes quotes and prevents spreadsheet formulas',()=>{
 const csv=collectionsCsv([{id:'p',reference:'=SUM(1,2)',facility:'A "Clinic"',amount:10.1,status:'approved'}])
 expect(csv).toContain('"\'=SUM(1,2)"');expect(csv).toContain('"A ""Clinic"""');expect(csv).toContain('"10.10"')
})
