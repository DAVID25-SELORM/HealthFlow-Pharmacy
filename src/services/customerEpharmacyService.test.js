import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, signInWithOAuth, signInWithOtp } = vi.hoisted(() => ({
  invoke: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithOtp: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke },
    auth: { signInWithOAuth, signInWithOtp },
    storage: { from: vi.fn() },
  },
}))

vi.mock('../config/appUrl', () => ({
  getCustomerAuthRedirectUrl: () => 'https://example.com/shop',
}))

import {
  getCustomerCheckoutRequirements,
  sendCustomerMagicLink,
  signInCustomerWithProvider,
} from './customerEpharmacyService'

describe('customerEpharmacyService', () => {
  beforeEach(() => {
    invoke.mockReset()
    signInWithOAuth.mockReset()
    signInWithOtp.mockReset()
  })

  it('uses native OAuth for Google and Apple customer sign-in', async () => {
    signInWithOAuth.mockResolvedValue({ data: {}, error: null })

    await signInCustomerWithProvider('google')

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'https://example.com/shop',
        queryParams: { prompt: 'select_account' },
      },
    })
  })

  it('uses magic-link sign-in for Yahoo and other email accounts', async () => {
    signInWithOtp.mockResolvedValue({ error: null })

    await sendCustomerMagicLink('person@yahoo.com')

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'person@yahoo.com',
      options: expect.objectContaining({
        emailRedirectTo: 'https://example.com/shop',
        shouldCreateUser: true,
      }),
    })
  })

  it('keeps OTC checkout simple and expands prescription requirements', () => {
    expect(getCustomerCheckoutRequirements({
      listing: { sale_class: 'otc' },
      fulfillmentMethod: 'pickup',
    })).toEqual({
      prescription: false,
      requiresDeliveryAddress: false,
      requiresPatientDetails: false,
      requiresClinicalDetails: false,
      requiresPrescriptionUpload: false,
    })

    expect(getCustomerCheckoutRequirements({
      listing: { sale_class: 'prescription' },
      fulfillmentMethod: 'delivery',
    })).toEqual({
      prescription: true,
      requiresDeliveryAddress: true,
      requiresPatientDetails: true,
      requiresClinicalDetails: true,
      requiresPrescriptionUpload: true,
    })
  })
})
