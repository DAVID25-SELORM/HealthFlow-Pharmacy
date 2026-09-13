import { describe, expect, it, vi } from 'vitest'
import { createPrescriptionUploadSession } from './prescriptionUploadSession'

describe('prescription upload retries', () => {
  it('reuses an in-flight and completed upload for the same file and scope', async () => {
    const session = createPrescriptionUploadSession()
    const file = {}; const scope = { organizationId: 'a', claimId: 'b' }
    const upload = vi.fn().mockResolvedValue({ prescriptionFilePath: 'saved.pdf' })
    const first = session.upload(file, scope, upload)
    expect(session.upload(file, scope, upload)).toBe(first)
    await first
    await session.upload(file, scope, upload)
    expect(upload).toHaveBeenCalledTimes(1)
  })
  it('retries failed uploads and does not reuse another file, user or organization', async () => {
    const session = createPrescriptionUploadSession(); const file = {}
    const upload = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})
    await expect(session.upload(file, { organizationId: 'a' }, upload)).rejects.toThrow('offline')
    await session.upload(file, { organizationId: 'a' }, upload)
    await session.upload(file, { organizationId: 'b' }, upload)
    await session.upload({}, { organizationId: 'b' }, upload)
    session.clear()
    await session.upload(file, { organizationId: 'b' }, upload)
    expect(upload).toHaveBeenCalledTimes(5)
  })
})
