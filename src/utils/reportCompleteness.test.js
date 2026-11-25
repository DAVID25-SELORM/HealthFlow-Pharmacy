import { describe, expect, it } from 'vitest'
import { REPORT_ROW_CAP, describePartials, getReportPartials, getReportWarnings } from './reportCompleteness'
import { REPORT_CATALOG } from '../services/reportsService'

const rows = (count) => Array.from({ length: count }, (_, index) => ({ id: index }))
const cloud = (extra = {}) => ({ pagination: { nhisClaims: { total: 0 } }, nhisClaims: [], ...extra })

describe('knowing when a report is incomplete', () => {
  it('is complete when every claim is loaded and nothing reached the limit', () => {
    expect(getReportPartials(cloud({ nhisClaims: rows(200), pagination: { nhisClaims: { total: 200 } }, sales: rows(999) }))).toEqual({})
  })

  it('flags NHIS claims when the server has more than were loaded', () => {
    const partials = getReportPartials(cloud({ nhisClaims: rows(200), pagination: { nhisClaims: { total: 1234 } } }))
    expect(partials.nhis).toEqual({ loaded: 200, total: 1234 })
    expect(describePartials(partials)[0]).toBe('Only 200 of 1,234 NHIS claims are loaded, so NHIS claim and medicine figures are incomplete.')
  })

  it('flags any other list that reached the 1,000-record limit', () => {
    const partials = getReportPartials(cloud({ sales: rows(REPORT_ROW_CAP), drugs: rows(REPORT_ROW_CAP), patients: rows(10) }))
    expect(Object.keys(partials)).toEqual(['sales', 'drugs'])
    expect(describePartials(partials)).toHaveLength(2)
  })

  it('does not apply to the offline server, which sends no NHIS pagination', () => {
    expect(getReportPartials({ nhisClaims: rows(5), sales: rows(5000) })).toEqual({})
    expect(getReportPartials(undefined)).toEqual({})
  })

  it('warns only on the reports built from the incomplete records', () => {
    const partials = { nhis: { loaded: 200, total: 900 }, drugs: true }
    expect(getReportWarnings('drug-utilization', partials)).toHaveLength(1)
    expect(getReportWarnings('inventory-stock', partials)[0]).toMatch(/Inventory stops/)
    expect(getReportWarnings('drug-movement', partials)).toHaveLength(2)
    expect(getReportWarnings('sales-summary', partials)).toEqual([])
    // counted by the server across every claim
    expect(getReportWarnings('monthly-nhis-submission', partials)).toEqual([])
  })

  it('treats an unknown report as using everything', () => {
    expect(getReportWarnings('something-new', { sales: true, drugs: true })).toHaveLength(2)
  })

  it('has decided what every report in the catalogue is built from', () => {
    const everything = { nhis: { loaded: 1, total: 2 }, sales: true, drugs: true, patients: true, purchases: true, claims: true, suppliers: true }
    const treatedAsUnknown = REPORT_CATALOG.filter((report) => getReportWarnings(report.id, everything).length === 7)
    expect(treatedAsUnknown.map((report) => report.id)).toEqual([])
  })
})
