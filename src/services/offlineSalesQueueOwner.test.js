import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createSale: vi.fn(), createClaim: vi.fn() }))
vi.mock('./salesService', () => ({ createSale: mocks.createSale }))
vi.mock('./claimsService', () => ({ createClaim: mocks.createClaim }))
vi.mock('../utils/browserEncryption', () => ({
  encryptJson: async (value) => JSON.stringify(value),
  decryptJson: async (value) => JSON.parse(value),
}))

import { getOfflineSalesSummary, queueOfflineSale, syncOfflineSales } from './offlineSalesQueue'

// Just enough of the browser's storage for the real queue code to run against.
const installBrowserStorage = () => {
  const records = new Map()
  const answer = (result) => {
    const request = { result }
    queueMicrotask(() => request.onsuccess?.())
    return request
  }
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({
      objectStore: () => ({
        getAll: () => answer([...records.values()]),
        put: (record) => answer(records.set(record.id, record) && record.id),
      }),
    }),
    close: () => {},
  }
  window.indexedDB = { open: () => answer(database) }
}

const pharmacyA = { organizationId: 'pharmacy-a', userId: 'staff-a' }
const pharmacyB = { organizationId: 'pharmacy-b', userId: 'staff-b' }
const queue = (owner, name) => queueOfflineSale({
  salePayload: { items: [{ id: name }], patientName: name },
  claimPayload: { patientName: name, items: [{ id: name }] },
  organizationId: owner.organizationId,
  createdBy: owner.userId,
})

describe('offline sales queued in a browser that two pharmacies use', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    installBrowserStorage()
    mocks.createSale.mockResolvedValue({ sale: { id: 'remote-sale' }, saleNumber: 'REMOTE-1' })
    await queue(pharmacyA, 'Invented Patient A')
  })

  it("are not sent, claim included, while another pharmacy is signed in", async () => {
    expect(await syncOfflineSales(pharmacyB)).toMatchObject({ synced: 0, failed: 0 })
    expect(mocks.createSale).not.toHaveBeenCalled()
    expect(mocks.createClaim).not.toHaveBeenCalled()
    expect((await getOfflineSalesSummary(pharmacyB)).total).toBe(0)
  })

  it('wait unchanged and are sent when their own pharmacy signs in again', async () => {
    await syncOfflineSales(pharmacyB)
    expect(await getOfflineSalesSummary(pharmacyA)).toMatchObject({ total: 1, pending: 1 })

    expect(await syncOfflineSales(pharmacyA)).toMatchObject({ synced: 1, failed: 0 })
    expect(mocks.createSale).toHaveBeenCalledTimes(1)
    expect(mocks.createClaim).toHaveBeenCalledTimes(1)
  })

  it('send nothing when it is not known who is signed in', async () => {
    expect(await syncOfflineSales()).toMatchObject({ synced: 0 })
    expect(mocks.createSale).not.toHaveBeenCalled()
  })

  it('keep a sale that records no pharmacy with the person who made it', async () => {
    installBrowserStorage()
    await queue({ organizationId: null, userId: 'staff-a' }, 'Invented Walk-in')
    expect((await getOfflineSalesSummary(pharmacyB)).total).toBe(0)
    expect((await getOfflineSalesSummary(pharmacyA)).total).toBe(1)
  })
})
