import { describe, expect, it } from 'vitest'
import { filterRecycleBinRecords } from './RecycleBin'

const records = [
  {
    id: 'claim-1',
    entity_type: 'nhis_claim',
    display_name: 'NHIS-00124',
    deleted_at: '2026-08-08T09:00:00.000Z',
    snapshot: {
      record: {
        claim_number: 'NHIS-00124',
        surname: 'Mensah',
        other_names: 'Kofi',
        member_no: '12345678',
        folder_no: 'G-1042',
      },
    },
  },
  {
    id: 'drug-1',
    entity_type: 'inventory_drug',
    display_name: 'Paracetamol 500 mg',
    deleted_at: '2026-07-10T09:00:00.000Z',
    snapshot: { record: { code: 'PARACETA1', generic_name: 'Paracetamol' } },
  },
]

describe('filterRecycleBinRecords', () => {
  it('searches claim identity fields without changing the source records', () => {
    expect(filterRecycleBinRecords(records, { searchTerm: 'G-1042' })).toEqual([records[0]])
    expect(filterRecycleBinRecords(records, { searchTerm: 'mensah kofi' })).toEqual([records[0]])
    expect(records).toHaveLength(2)
  })

  it('searches inventory names and codes', () => {
    expect(filterRecycleBinRecords(records, { searchTerm: 'paraceta1' })).toEqual([records[1]])
  })

  it('filters by record type and deletion age', () => {
    const now = new Date('2026-08-08T12:00:00.000Z')
    expect(filterRecycleBinRecords(records, { entityType: 'nhis_claim' }, now)).toEqual([records[0]])
    expect(filterRecycleBinRecords(records, { deletedWithin: '7_days' }, now)).toEqual([records[0]])
  })
})
