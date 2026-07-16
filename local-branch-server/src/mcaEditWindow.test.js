import { describe, expect, it } from 'vitest'
import {
  isMcaEditWindowOpen,
  canReopenMcaEditWindow,
  buildMcaEditReopenFields,
  MCA_EDIT_WINDOW_HOURS,
  MCA_EDIT_REOPEN_HOURS,
} from './mcaEditWindow.js'

const H = 60 * 60 * 1000
const now = Date.parse('2026-06-14T12:00:00.000Z')

describe('dispensary edit window', () => {
  it('is open within 24h of creation', () => {
    const claim = { created_at: new Date(now - 1 * H).toISOString() }
    expect(isMcaEditWindowOpen(claim, now)).toBe(true)
  })

  it('is closed after 24h with no re-open', () => {
    const claim = { created_at: new Date(now - 25 * H).toISOString() }
    expect(isMcaEditWindowOpen(claim, now)).toBe(false)
  })

  it('re-opens when mca_edit_reopened_until is in the future', () => {
    const claim = {
      created_at: new Date(now - 30 * H).toISOString(),
      mca_edit_reopened_until: new Date(now + 1 * H).toISOString(),
    }
    expect(isMcaEditWindowOpen(claim, now)).toBe(true)
  })

  it('stays closed when the re-open has expired', () => {
    const claim = {
      created_at: new Date(now - 30 * H).toISOString(),
      mca_edit_reopened_until: new Date(now - 1 * H).toISOString(),
    }
    expect(isMcaEditWindowOpen(claim, now)).toBe(false)
  })

  it('treats a missing created_at as closed unless re-opened', () => {
    expect(isMcaEditWindowOpen({}, now)).toBe(false)
    expect(isMcaEditWindowOpen({ mca_edit_reopened_until: new Date(now + H).toISOString() }, now)).toBe(true)
  })

  it('only admin / claims officer may re-open', () => {
    expect(canReopenMcaEditWindow('admin')).toBe(true)
    expect(canReopenMcaEditWindow('claims_officer')).toBe(true)
    expect(canReopenMcaEditWindow('assistant')).toBe(false)
    expect(canReopenMcaEditWindow('pharmacist')).toBe(false)
  })

  it('builds re-open fields for a 12h extension with reason + actor', () => {
    const fields = buildMcaEditReopenFields({ reason: 'Late correction', reopenedBy: 'user-1', now })
    expect(fields.mca_edit_reopen_reason).toBe('Late correction')
    expect(fields.mca_edit_reopened_by).toBe('user-1')
    expect(Date.parse(fields.mca_edit_reopened_until)).toBe(now + MCA_EDIT_REOPEN_HOURS * H)
  })

  it('uses the configured window constants', () => {
    expect(MCA_EDIT_WINDOW_HOURS).toBe(24)
    expect(MCA_EDIT_REOPEN_HOURS).toBe(12)
  })
})
