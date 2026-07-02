import { describe, expect, it, vi } from 'vitest'
import { buildActionConfirmation, confirmAction } from './actionConfirmation'

describe('action confirmation', () => {
  it('builds a review message and omits empty details', () => {
    expect(buildActionConfirmation({
      title: 'Approve claim?',
      details: [
        { label: 'Claim', value: 'CLM-001' },
        { label: 'Patient', value: '' },
      ],
      warning: 'This changes the claim status.',
      confirmText: 'approve this claim',
    })).toBe(
      'Approve claim?\n\nReview before continuing:\n• Claim: CLM-001\n\n' +
      'This changes the claim status.\n\nSelect OK to approve this claim.',
    )
  })

  it('returns the browser confirmation result', () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    expect(confirmAction({ title: 'Continue?' })).toBe(true)
    expect(window.confirm).toHaveBeenCalledWith(
      'Continue?\n\nSelect OK to continue.',
    )
  })
})
