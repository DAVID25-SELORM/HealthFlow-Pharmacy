import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectAuthStorage, isAuthDiagnosticsEnabled, logAuthDiagnostic, logAuthServerClock, logAuthSession } from './authDiagnostics'
import { classifyAuthFailure } from './authFailure'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('safe auth diagnostics', () => {
  it('reports unavailable storage without throwing', () => {
    const blocked = { get localStorage() { throw new DOMException('Denied', 'SecurityError') } }
    expect(inspectAuthStorage('test', blocked)).toEqual({ localStorageAvailable: false, sessionStorageAvailable: false, cookiesAvailable: false })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(isAuthDiagnosticsEnabled()).toBe(false)
  })
  it('checks persistence presence and cleans up harmless probe keys', () => {
    window.localStorage.setItem('test-session', 'private-value')
    const before = window.localStorage.length
    expect(inspectAuthStorage('test-session')).toMatchObject({localStorageAvailable: true, localStorageSessionPresent: true, sessionStorageAvailable: true})
    expect(window.localStorage.length).toBe(before)
    window.localStorage.removeItem('test-session')
  })
  it('never emits session secrets, error messages or patient data', () => {
    vi.stubEnv('VITE_HEALTHFLOW_AUTH_DIAGNOSTICS', 'true')
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    logAuthSession('SIGNED_IN', {access_token:'secret-access', refresh_token:'secret-refresh', user:{email:'private-email'}, expires_at:123}, 'test-session')
    logAuthDiagnostic('test', {password:'secret-password', errorMessage:'Bearer secret-access', patient:{name:'private-patient'}, token:'secret-refresh'})
    const output = JSON.stringify(log.mock.calls)
    for (const secret of ['secret-access','secret-refresh','secret-password','private-patient','private-email']) expect(output).not.toContain(secret)
    expect(output).toContain('expiresAt')
  })
  it('reports significant clock skew and absent server Date headers', () => {
    vi.stubEnv('VITE_HEALTHFLOW_AUTH_DIAGNOSTICS', 'true')
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    logAuthServerClock(new Response(null, {headers:{Date:new Date(0).toUTCString()}}), 300000, 300200)
    expect(log).toHaveBeenLastCalledWith('[HealthFlow auth]', expect.objectContaining({significantClockSkew:true}))
    logAuthServerClock(new Response(), 300000, 300200)
    expect(log).toHaveBeenLastCalledWith('[HealthFlow auth]', expect.objectContaining({serverTimeAvailable:false,clockSkewMs:null}))
  })
  it.each([[400,'APPLICATION_ERROR'],[403,'ACCESS_DENIED'],[500,'SERVER_ERROR'],[401,'AUTH_REJECTED']])('classifies application status %s', (status, category) => {
    expect(classifyAuthFailure({status,name:'AuthApiError'})).toBe(category)
  })
})
