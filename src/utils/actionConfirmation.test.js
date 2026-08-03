import { describe, expect, it } from 'vitest'
import { buildActionConfirmation, confirmAction } from './actionConfirmation'

describe('action confirmation', () => {
  it('builds dialog options and omits empty details', () => {
    expect(buildActionConfirmation({
      title: 'Approve claim?',
      details: [
        { label: 'Claim', value: 'CLM-001' },
        { label: 'Patient', value: '' },
      ],
      warning: 'This changes the claim status.',
      confirmText: 'approve this claim',
    })).toEqual({
      title: 'Approve claim?',
      details: [{ label: 'Claim', value: 'CLM-001' }],
      warning: 'This changes the claim status.',
      confirmText: 'approve this claim',
    })
  })

  it('resolves through the HealthFlow app dialog event', async () => {
    const listener = (event) => {
      expect(event.detail.type).toBe('confirm')
      expect(event.detail.title).toBe('Continue?')
      event.detail.markHandled()
      event.detail.resolve(true)
    }
    window.addEventListener('healthflow:app-dialog', listener, { once: true })

    await expect(confirmAction({ title: 'Continue?' })).resolves.toBe(true)
  })

  it('fails closed when no app dialog provider handles the event', async () => {
    await expect(confirmAction({ title: 'Continue?' })).resolves.toBe(false)
  })
})
