import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getNhisServedReductions, isServedReductionReasonError } from './nhisServedReductions'

const saved = (code, served, extra = {}) => ({ drug_code: code, description: `Medicine ${code}`, served_qty: served, ...extra })
const edited = (code, served, extra = {}) => ({ drugCode: code, description: `Medicine ${code}`, servedQty: served, ...extra })

describe('served quantity reductions', () => {
  it('finds a lowered quantity', () => {
    expect(getNhisServedReductions([saved('AAA', 30)], [edited('AAA', 20)])).toEqual([
      { key: 'AAA', description: 'Medicine AAA', from: 30, to: 20, removed: false },
    ])
  })

  it('finds a removed medicine', () => {
    expect(getNhisServedReductions([saved('AAA', 30), saved('BBB', 5)], [edited('BBB', 5)])).toEqual([
      { key: 'AAA', description: 'Medicine AAA', from: 30, to: 0, removed: true },
    ])
  })

  it('asks for nothing when quantities stay, go up, or were never served', () => {
    expect(getNhisServedReductions(
      [saved('AAA', 30), saved('BBB', 5), saved('CCC', 0)],
      [edited('aaa', '30'), edited('BBB', 9)]
    )).toEqual([])
    expect(getNhisServedReductions(undefined, undefined)).toEqual([])
  })

  it('matches by catalogue ID, whatever its letter case', () => {
    expect(getNhisServedReductions(
      [saved('AAA', 10, { nhis_drug_id: 'ABC-1' })],
      [edited('changed-code', 10, { nhisDrugId: 'abc-1' })]
    )).toEqual([])
  })

  it('adds up two lines of the same medicine', () => {
    expect(getNhisServedReductions([saved('AAA', 10), saved('AAA', 10)], [edited('AAA', 20)])).toEqual([])
    expect(getNhisServedReductions([saved('AAA', 10), saved('AAA', 10)], [edited('AAA', 15)]))
      .toMatchObject([{ from: 20, to: 15 }])
  })

  it('reads older saved lines that only have a dispensed quantity', () => {
    expect(getNhisServedReductions(
      [{ drug_code: 'AAA', description: 'Medicine AAA', dispensed_qty: 8 }],
      [edited('AAA', 6)]
    )).toMatchObject([{ from: 8, to: 6 }])
  })

  it('recognises the exact message the database raises', () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      'supabase/migrations/20261120100000_return_stock_when_served_quantity_is_reduced.sql'
    ), 'utf8')
    const message = migration.match(/raise exception '(A reason is required[^']*)'/)?.[1]

    expect(isServedReductionReasonError(message)).toBe(true)
    expect(isServedReductionReasonError('A reason is required.')).toBe(false)
    expect(isServedReductionReasonError(undefined)).toBe(false)
  })
})
