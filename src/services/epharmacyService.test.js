import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeTierAccess } = vi.hoisted(() => ({
  invokeTierAccess: vi.fn(),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess,
}))

import {
  createEpharmacyOrder,
  getEpharmacyMarketplace,
  getEpharmacySurplusQuantity,
  isEpharmacyListingAvailable,
  requiresEpharmacyReview,
  updateEpharmacyListingControls,
  updateEpharmacyOrderStatus,
} from './epharmacyService'

describe('epharmacyService', () => {
  beforeEach(() => {
    invokeTierAccess.mockReset()
  })

  it('loads marketplace through tier-access with bounded filters', async () => {
    invokeTierAccess.mockResolvedValue({ listings: [] })

    await expect(getEpharmacyMarketplace({
      searchTerm: ' paracetamol ',
      facilityId: 'seller-1',
      limit: 50,
    })).resolves.toEqual({ listings: [] })

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'get_epharmacy_marketplace',
      searchTerm: 'paracetamol',
      facilityId: 'seller-1',
      limit: 50,
    })
  })

  it('blocks restricted medicines before publishing online', async () => {
    await expect(updateEpharmacyListingControls('drug-1', {
      saleClass: 'controlled',
      interfacilityVisible: true,
    })).rejects.toThrow('Restricted, controlled, and narcotic medicines cannot be published')

    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('forces prescription class listings into pharmacist review', async () => {
    invokeTierAccess.mockResolvedValue({ listing: { id: 'drug-1' } })

    await updateEpharmacyListingControls('drug-1', {
      saleClass: 'prescription',
      interfacilityVisible: true,
      requiresPrescription: false,
    })

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'update_epharmacy_listing_controls',
      drugId: 'drug-1',
      controls: expect.objectContaining({
        saleClass: 'prescription',
        requiresPrescription: true,
      }),
    })
  })

  it('allows listings to be unpublished when all channels are off', async () => {
    invokeTierAccess.mockResolvedValue({ listing: { id: 'drug-1' } })

    await updateEpharmacyListingControls('drug-1', {
      saleClass: 'otc',
      visible: false,
      interfacilityVisible: false,
      customerVisible: false,
    })

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'update_epharmacy_listing_controls',
      drugId: 'drug-1',
      controls: expect.objectContaining({
        visible: false,
        interfacilityVisible: false,
        customerVisible: false,
      }),
    })
  })

  it('uses surplus stock above reorder level as online availability', () => {
    expect(getEpharmacySurplusQuantity({ quantity: 20, reorder_level: 5 })).toBe(15)
    expect(getEpharmacySurplusQuantity({ quantity: 4, reorder_level: 5 })).toBe(0)
  })

  it('does not treat expired or controlled stock as available', () => {
    expect(isEpharmacyListingAvailable({
      quantity: 20,
      reorder_level: 5,
      expiry_date: '2099-12-31',
      sale_class: 'otc',
      epharmacy_interfacility_visible: true,
    })).toBe(true)

    expect(isEpharmacyListingAvailable({
      quantity: 20,
      reorder_level: 5,
      expiry_date: '2020-01-01',
      sale_class: 'otc',
      epharmacy_interfacility_visible: true,
    })).toBe(false)

    expect(isEpharmacyListingAvailable({
      quantity: 20,
      reorder_level: 5,
      expiry_date: '2099-12-31',
      sale_class: 'narcotic',
      epharmacy_interfacility_visible: true,
    })).toBe(false)
  })

  it('creates inter-facility orders through tier-access', async () => {
    invokeTierAccess.mockResolvedValue({ order: { id: 'order-1' } })

    await createEpharmacyOrder({
      sellerOrganizationId: 'seller-1',
      fulfillmentMethod: 'pickup',
      paymentMethod: 'momo',
      items: [{ drugId: 'drug-1', quantity: '3' }],
    })

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'create_epharmacy_order',
      order: expect.objectContaining({
        sellerOrganizationId: 'seller-1',
        fulfillmentMethod: 'pickup',
        paymentMethod: 'momo',
        items: [{ drugId: 'drug-1', quantity: 3 }],
      }),
    })
  })

  it('updates order status through tier-access', async () => {
    invokeTierAccess.mockResolvedValue({ order: { id: 'order-1', status: 'approved' } })

    await updateEpharmacyOrderStatus({
      orderId: 'order-1',
      status: 'approved',
      note: 'Reviewed',
    })

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'update_epharmacy_order_status',
      orderId: 'order-1',
      status: 'approved',
      note: 'Reviewed',
      rejectionReason: '',
    })
  })

  it('marks prescription class medicines for review', () => {
    expect(requiresEpharmacyReview('prescription')).toBe(true)
    expect(requiresEpharmacyReview('otc')).toBe(false)
  })
})
