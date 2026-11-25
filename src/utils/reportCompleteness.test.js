import { describe, expect, it } from 'vitest'
import {
  REPORT_ROW_CAP, appendNhisPage, describePartials, getNhisPagedCount, getReportPartials, getReportWarnings,
} from './reportCompleteness'
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
    const partials = { nhis: { loaded: 200, total: 900 }, drugs: { limit: 1000 } }
    expect(getReportWarnings('drug-utilization', partials)).toHaveLength(1)
    expect(getReportWarnings('inventory-stock', partials)[0]).toMatch(/Inventory items stop at 1,000 records/)
    expect(getReportWarnings('drug-movement', partials)).toHaveLength(2)
    expect(getReportWarnings('sales-summary', partials)).toEqual([])
    // counted by the server across every claim
    expect(getReportWarnings('monthly-nhis-submission', partials)).toEqual([])
  })

  it('treats an unknown report as using everything', () => {
    expect(getReportWarnings('something-new', { sales: { limit: 1000 }, drugs: { limit: 1000 } })).toHaveLength(2)
  })

  it('has decided what every report in the catalogue is built from', () => {
    const full = { limit: 1000 }
    const everything = {
      nhis: { loaded: 1, total: 2 }, sales: full, drugs: full, patients: full, purchases: full, claims: full, suppliers: full,
      exportHistory: full, submissionLogs: full,
    }
    const treatedAsUnknown = REPORT_CATALOG.filter((report) => getReportWarnings(report.id, everything).length === Object.keys(everything).length)
    expect(treatedAsUnknown.map((report) => report.id)).toEqual([])
  })
})

describe('what a newer report service says', () => {
  const server = (extra = {}) => ({ pagination: { nhisClaims: { total: 0 }, truncated: {} }, nhisClaims: [], ...extra })

  it('is believed: more than 1,000 records is fine when nothing was cut off', () => {
    expect(getReportPartials(server({ sales: rows(1500), drugs: rows(3000) }))).toEqual({})
  })

  it('flags a list it says it cut off, even if fewer rows are shown', () => {
    const partials = getReportPartials(server({ sales: rows(40), pagination: { nhisClaims: { total: 0 }, truncated: { sales: true } } }))
    expect(describePartials(partials)).toEqual([
      "Sales go past the report's record limit, so sales figures are incomplete. Choose a shorter period.",
    ])
  })

  it('says when a list could not be read at all, so an empty one is not taken as zero', () => {
    const partials = getReportPartials(server({ unavailable: ['purchases', 'submissionLogs', 'nhisClaims'] }))
    expect(describePartials(partials)).toEqual([
      'NHIS claims could not be loaded, so NHIS claim and medicine figures are missing.',
      'Purchases could not be loaded, so purchase figures are missing.',
      'CC code requests could not be loaded, so CC code figures are missing.',
    ])
    expect(getReportWarnings('cc-code-generation', partials)).toHaveLength(1)
  })
})

describe('reading further pages of NHIS claims', () => {
  const first = (extra = {}) => ({
    nhisClaims: rows(200),
    pagination: { nhisClaims: { offset: 0, limit: 200, total: 450, hasMore: true } },
    ...extra,
  })

  it('starts after the first batch, even when a drug filter added claims on top of it', () => {
    expect(getNhisPagedCount(first())).toBe(200)
    expect(getNhisPagedCount(first({ nhisClaims: rows(260) }))).toBe(200)
  })

  it('adds a page without repeating a claim, and remembers how far it has read', () => {
    const page = Array.from({ length: 250 }, (_, index) => ({ id: index + 190 }))
    const next = appendNhisPage(first(), { nhisClaims: page, pagination: { total: 450, hasMore: false } }, 200)
    expect(next.nhisClaims).toHaveLength(440)
    expect(getNhisPagedCount(next)).toBe(450)
    expect(next.pagination.nhisClaims).toMatchObject({ limit: 200, total: 450, hasMore: false })
    // a claim missed between pages is still reported as missing
    expect(getReportPartials(next).nhis).toEqual({ loaded: 440, total: 450 })
  })

  it('stops when the server sends nothing more, even if it says there is more', () => {
    const next = appendNhisPage(first(), { nhisClaims: [], pagination: { total: 450, hasMore: true } }, 200)
    expect(next.pagination.nhisClaims.hasMore).toBe(false)
  })
})
