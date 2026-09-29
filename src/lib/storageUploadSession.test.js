import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('prescription storage session recovery', () => {
  const fresh = { access_token: 'fresh', expires_at: 4102444800 }
  let getSession
  let refreshSession
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-key')
    getSession = vi.fn().mockResolvedValue({ data: { session: fresh }, error: null })
    refreshSession = vi.fn().mockResolvedValue({ data: { session: fresh }, error: null })
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ auth: { getSession, refreshSession }, functions: {} }),
    }))
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('refreshes a stale session before attempting an upload', async () => {
    getSession.mockResolvedValue({ data: { session: { ...fresh, expires_at: 1 } }, error: null })
    const { withStorageUploadSession } = await import('./supabase')
    const upload = vi.fn(async () => {
      expect(refreshSession).toHaveBeenCalledTimes(1)
      return { data: { path: 'same-path' }, error: null }
    })
    await expect(withStorageUploadSession(upload)).resolves.toMatchObject({ error: null })
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it.each([
    { statusCode: '403', message: 'new row violates row-level security policy' },
    { statusCode: '400', code: 'InvalidJWT', message: 'Invalid JWT' },
  ])('retries a rejected upload once after refresh: %j', async (error) => {
    const { withStorageUploadSession } = await import('./supabase')
    const upload = vi.fn().mockResolvedValueOnce({ error }).mockResolvedValueOnce({ data: { path: 'same-path' }, error: null })
    await expect(withStorageUploadSession(upload)).resolves.toMatchObject({ error: null })
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('does not loop when permission is genuinely denied', async () => {
    const { withStorageUploadSession } = await import('./supabase')
    const rejection = { error: { message: 'new row violates row-level security policy' } }
    const upload = vi.fn().mockResolvedValue(rejection)
    await expect(withStorageUploadSession(upload)).resolves.toBe(rejection)
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it.each(['InvalidMimeType', 'EntityTooLarge', 'NoSuchBucket', 'InternalError'])('does not retry %s', async (code) => {
    const { withStorageUploadSession } = await import('./supabase')
    const result = { error: { code, statusCode: '400', message: 'Storage rejected the file' } }
    const upload = vi.fn().mockResolvedValue(result)
    await expect(withStorageUploadSession(upload)).resolves.toBe(result)
    expect(refreshSession).not.toHaveBeenCalled()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('blocks an upload when no session exists', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null })
    const { withStorageUploadSession } = await import('./supabase')
    const upload = vi.fn()
    await expect(withStorageUploadSession(upload)).rejects.toThrow('Please sign in again')
    expect(upload).not.toHaveBeenCalled()
  })

  it('preserves a refresh outage and does not send a stale upload', async () => {
    getSession.mockResolvedValue({ data: { session: { ...fresh, expires_at: 1 } }, error: null })
    const error = { status: 503, message: 'Service unavailable' }
    refreshSession.mockResolvedValue({ data: { session: null }, error })
    const { withStorageUploadSession } = await import('./supabase')
    const upload = vi.fn()
    await expect(withStorageUploadSession(upload)).rejects.toEqual(error)
    expect(upload).not.toHaveBeenCalled()
  })
})
