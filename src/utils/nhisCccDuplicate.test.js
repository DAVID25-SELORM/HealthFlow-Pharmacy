import { describe, expect, it } from 'vitest'
import {
  NHIS_CCC_DUPLICATE_REASON,
  NHIS_CCC_DUPLICATE_SEVERITY,
  classifyNhisCccDuplicateSignals,
  getStrongestNhisCccDuplicateSignal,
  isBlockingNhisCccDuplicateSignal,
} from './nhisCccDuplicate'

const claim = (over) => ({
  id: 'other-1', memberNo: '40000001', ccc: '14587', serviceDate: '2026-09-14', status: 'served', claimNumber: 'NHIS-000001', totalAmount: 100, ...over,
})
const candidate = (over) => ({ id: 'new-claim', memberNo: '40000001', ccc: '14587', serviceDate: '2026-09-14', totalAmount: 100, ...over })

describe('classifyNhisCccDuplicateSignals: the 5-category member-aware model', () => {
  it('1. same member + same CCC + same service date => BLOCK (strong duplicate)', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim()])
    expect(signal).toMatchObject({ severity: NHIS_CCC_DUPLICATE_SEVERITY.BLOCK, reasonCode: NHIS_CCC_DUPLICATE_REASON.STRONG_DUPLICATE })
    expect(signal.message).toContain('same service date')
    expect(isBlockingNhisCccDuplicateSignal(signal)).toBe(true)
  })

  it('2. same member + same CCC + date within the warning window => STRONG_WARNING, not an automatic duplicate', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim({ serviceDate: '2026-09-16' })]) // 2 days apart
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING)
    expect(signal.reasonCode).toBe(NHIS_CCC_DUPLICATE_REASON.STRONG_DUPLICATE_WINDOW)
    expect(isBlockingNhisCccDuplicateSignal(signal)).toBe(false)
  })

  it('3. different member + same CCC => allowed (informational only, never blocks)', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim({ memberNo: '50000002' })])
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.INFO)
    expect(isBlockingNhisCccDuplicateSignal(signal)).toBe(false)
  })

  it('4. different member + same CCC + same date => still only an informational warning', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim({ memberNo: '50000002', serviceDate: '2026-09-14' })])
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.INFO)
    expect(signal.message).toContain('does not automatically prevent')
  })

  it('5. same member + same date + different CCC => WARNING (possible duplicate encounter)', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim({ ccc: '99999' })])
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.WARNING)
    expect(signal.reasonCode).toBe(NHIS_CCC_DUPLICATE_REASON.SAME_MEMBER_DIFFERENT_CCC)
  })

  it('6. same member + same CCC + clearly different date => REVIEW, not an automatic duplicate', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim({ serviceDate: '2026-08-01' })])
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.REVIEW)
    expect(signal.reasonCode).toBe(NHIS_CCC_DUPLICATE_REASON.SAME_MEMBER_SAME_CCC_DIFFERENT_DATE)
    expect(isBlockingNhisCccDuplicateSignal(signal)).toBe(false)
  })

  it('7. a cancelled/voided (rejected or failed) existing claim is not a live same-member duplicate', () => {
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ status: 'rejected' })])).toEqual([])
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ status: 'failed' })])).toEqual([])
  })

  it('a rejected claim sharing the CCC with a DIFFERENT member still surfaces the informational notice', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim({ memberNo: '50000002', status: 'rejected' })])
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.INFO)
  })

  it('8. a draft existing claim is still a live duplicate candidate', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim({ status: 'draft' })])
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
  })

  it('9. a served/submitted existing claim is a live (blocking-strength) duplicate candidate', () => {
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ status: 'served' })])[0].severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ status: 'submitted' })])[0].severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
  })

  it('a pending CCC allows same-member/date review without a hard block', () => {
    expect(classifyNhisCccDuplicateSignals(candidate({ ccc: '' }), [claim()])[0].severity).toBe('warning')
  })

  it('12. manual CCC entry and 13. NHIA-generated CCC are classified identically (the source of the value is not part of the model)', () => {
    const manual = classifyNhisCccDuplicateSignals({ ...candidate(), ccc: '14587', ccCode: undefined }, [claim()])
    const generated = classifyNhisCccDuplicateSignals({ ...candidate(), ccCode: '14587', ccc: undefined }, [claim()])
    expect(manual[0].severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
    expect(generated[0].severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
  })

  it('18. the same numeric CCC existing elsewhere never implies a global-uniqueness violation by itself', () => {
    // Five different members all sharing the same CCC at the same facility: none of them blocks any other.
    const others = ['a', 'b', 'c', 'd'].map((m) => claim({ id: m, memberNo: `6000000${m}` }))
    const signals = classifyNhisCccDuplicateSignals(candidate({ memberNo: '70000009' }), others)
    expect(signals.every((signal) => signal.severity === NHIS_CCC_DUPLICATE_SEVERITY.INFO)).toBe(true)
    expect(signals).toHaveLength(4)
  })

  it('ignores a row representing the claim being edited (its own previous version)', () => {
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ id: 'new-claim' })])).toEqual([])
  })

  it('accepts snake_case database rows as well as camelCase', () => {
    const dbCandidate = { id: 'new-claim', member_no: '40000001', ccc_no: '14587', service_date_from: '2026-09-14', total_amount: 100 }
    const dbOther = { id: 'other-1', member_no: '40000001', ccc_no: '14587', service_date_from: '2026-09-14', status: 'served', claim_number: 'NHIS-000001', total_amount: '100.00' }
    const [signal] = classifyNhisCccDuplicateSignals(dbCandidate, [dbOther])
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
    expect(signal.claim).toMatchObject({ claimNumber: 'NHIS-000001', memberNo: '40000001' })
  })

  it('normalizes member identity and CCC the same way regardless of formatting (dashes, spaces)', () => {
    const [signal] = classifyNhisCccDuplicateSignals(
      candidate({ memberNo: 'GHA-400-00001-0' }),
      [claim({ memberNo: 'GHA40000001 0' })]
    )
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
  })

  it('getStrongestNhisCccDuplicateSignal returns the most severe signal first (BLOCK over INFO)', () => {
    const signals = classifyNhisCccDuplicateSignals(candidate(), [
      claim({ id: 'other-2', memberNo: '50000002' }), // INFO
      claim({ id: 'other-3' }), // BLOCK
    ])
    expect(getStrongestNhisCccDuplicateSignal(signals).severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
  })

  it('returns no signal for a row that neither shares the CCC nor is a same-member/same-date match', () => {
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ ccc: '11111', serviceDate: '2026-01-01', memberNo: '99999999' })])).toEqual([])
  })

  it('10. same member + same date + different CCC + a near-identical medicine set => promoted to STRONG_WARNING (stronger duplicate confidence)', () => {
    const [signal] = classifyNhisCccDuplicateSignals(
      candidate({ medicines: ['PARA500', 'AMOX250'] }),
      [claim({ ccc: '99999', medicines: ['PARA500', 'AMOX250'] })]
    )
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING)
    expect(signal.reasonCode).toBe(NHIS_CCC_DUPLICATE_REASON.SAME_MEMBER_DIFFERENT_CCC)
    expect(signal.medicineOverlapRatio).toBe(1)
  })

  it('11. same member + same date + different CCC + a disjoint medicine set => still only a plain WARNING, context-aware rather than auto-escalated', () => {
    const [signal] = classifyNhisCccDuplicateSignals(
      candidate({ medicines: ['PARA500'] }),
      [claim({ ccc: '99999', medicines: ['IBUP400'] })]
    )
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.WARNING)
    expect(signal.medicineOverlapRatio).toBe(0)
  })

  it('medicine overlap is never computed, and never raises a signal by itself, when neither side records medicines', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate(), [claim({ ccc: '99999' })])
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.WARNING)
    expect(signal.medicineOverlapRatio).toBeNull()
  })

  it('medicine overlap never promotes a same-member/same-CCC signal past BLOCK (it only ever applies to the different-CCC case)', () => {
    const [signal] = classifyNhisCccDuplicateSignals(
      candidate({ medicines: ['PARA500'] }),
      [claim({ medicines: ['ZZZDIFFERENT'] })]
    )
    expect(signal.severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
  })
})

// Missing identities never fall back to patient names or the CCC itself.
it('uses HIN when member_no is empty, and patient ID only when both members are absent', () => {
  expect(classifyNhisCccDuplicateSignals(candidate({ memberNo: '', hin: '40000001' }), [claim()])[0].severity).toBe('block')
  expect(classifyNhisCccDuplicateSignals(candidate({ memberNo: '', patientId: 'p1' }), [claim({ memberNo: '', patient_id: 'p1' })])[0].severity).toBe('block')
  expect(classifyNhisCccDuplicateSignals(candidate({ memberNo: '', surname: 'Same' }), [claim({ memberNo: '', surname: 'Same' })])[0].severity).toBe('info')
})
it('does not flag another facility, even for the same member and CCC', () => {
  expect(classifyNhisCccDuplicateSignals(candidate({ organization_id: 'a' }), [claim({ organization_id: 'b' })])).toEqual([])
})
it.each(['cancelled', 'canceled', 'voided', 'rejected', 'failed'])('excludes %s records on either side', (status) => {
  expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ status })])).toEqual([])
  expect(classifyNhisCccDuplicateSignals(candidate({ status }), [claim()])).toEqual([])
})
describe('several prescriptions for one visit (same member + CCC + day)', () => {
  it('a different total is a strong warning that needs review, never a block', () => {
    const [signal] = classifyNhisCccDuplicateSignals(candidate({ totalAmount: 250 }), [claim()])
    expect(signal).toMatchObject({ severity: NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING, reasonCode: NHIS_CCC_DUPLICATE_REASON.STRONG_DUPLICATE_SAME_DAY })
    expect(isBlockingNhisCccDuplicateSignal(signal)).toBe(false)
  })

  it('a missing total on either side never blocks', () => {
    expect(classifyNhisCccDuplicateSignals(candidate({ totalAmount: 0 }), [claim()])[0].severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING)
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ totalAmount: undefined })])[0].severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING)
  })

  it('an exact repeat (same total) is still blocked as a double entry', () => {
    expect(classifyNhisCccDuplicateSignals(candidate({ totalAmount: 99.999 }), [claim({ totalAmount: 100 })])[0].severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.BLOCK)
  })

  it('three claims for the same visit with different totals produce warnings only', () => {
    const signals = classifyNhisCccDuplicateSignals(candidate({ totalAmount: 30 }), [claim({ id: 'a', totalAmount: 10 }), claim({ id: 'b', totalAmount: 20 })])
    expect(signals).toHaveLength(2)
    expect(signals.some(isBlockingNhisCccDuplicateSignal)).toBe(false)
  })
})

describe('different member sharing a CCC', () => {
  it('is mentioned only when the other claim is within a week of the service date', () => {
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ memberNo: '50000002', serviceDate: '2026-09-20' })])[0].severity).toBe(NHIS_CCC_DUPLICATE_SEVERITY.INFO)
    expect(classifyNhisCccDuplicateSignals(candidate(), [claim({ memberNo: '50000002', serviceDate: '2026-08-01' })])).toEqual([])
  })
})

it('reads stored medicine rows and ignores objects without a medicine code', () => {
  const [signal] = classifyNhisCccDuplicateSignals(candidate({ medicines: [{ drugCode: 'A' }, {}] }), [claim({ ccc: '98765', nhis_claim_medicines: [{ drug_code: 'A' }, {}] })])
  expect(signal.medicineOverlapRatio).toBe(1)
  expect(signal.claim.medicines).toEqual(['A'])
})
