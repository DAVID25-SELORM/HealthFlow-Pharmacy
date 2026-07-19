import { describe, expect, it, vi } from 'vitest'
import {
  HEALTHFLOW_INSTALLER_FALLBACK_URL,
  resolveHealthflowInstallerUrl,
  validateHealthflowInstallerUrl,
} from './branchUpdateConfig'

describe('resolveHealthflowInstallerUrl', () => {
  it('treats a missing value as not configured', () => {
    expect(resolveHealthflowInstallerUrl(undefined)).toEqual({
      url: HEALTHFLOW_INSTALLER_FALLBACK_URL,
      configured: false,
    })
  })

  it('treats an empty string as not configured', () => {
    expect(resolveHealthflowInstallerUrl('')).toEqual({
      url: HEALTHFLOW_INSTALLER_FALLBACK_URL,
      configured: false,
    })
  })

  it('treats a whitespace-only value as not configured', () => {
    expect(resolveHealthflowInstallerUrl('   ')).toEqual({
      url: HEALTHFLOW_INSTALLER_FALLBACK_URL,
      configured: false,
    })
  })

  it('treats the known legacy placeholder as not configured', () => {
    expect(resolveHealthflowInstallerUrl(HEALTHFLOW_INSTALLER_FALLBACK_URL)).toEqual({
      url: HEALTHFLOW_INSTALLER_FALLBACK_URL,
      configured: false,
    })
  })

  it('treats the placeholder with surrounding whitespace as not configured', () => {
    expect(resolveHealthflowInstallerUrl(`  ${HEALTHFLOW_INSTALLER_FALLBACK_URL}  `)).toEqual({
      url: HEALTHFLOW_INSTALLER_FALLBACK_URL,
      configured: false,
    })
  })

  it('treats a distinct, real-looking value as configured', () => {
    const real = 'https://cdn.healthflowgh.com/releases/HealthFlow-Offline-2.4.0.zip'
    expect(resolveHealthflowInstallerUrl(real)).toEqual({ url: real, configured: true })
  })

  it('trims surrounding whitespace from a configured value', () => {
    const real = 'https://cdn.healthflowgh.com/releases/HealthFlow-Offline-2.4.0.zip'
    expect(resolveHealthflowInstallerUrl(`  ${real}  `)).toEqual({ url: real, configured: true })
  })
})

describe('installer details display', () => {
  it('can derive a safe setup-details value without exposing the placeholder as a real installer', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_HEALTHFLOW_INSTALLER_URL', HEALTHFLOW_INSTALLER_FALLBACK_URL)

    const freshConfig = await import('./branchUpdateConfig')

    expect(freshConfig.HEALTHFLOW_INSTALLER_URL_CONFIGURED).toBe(false)
    expect(freshConfig.HEALTHFLOW_INSTALLER_DETAILS_VALUE).toBe('Not configured for this deployment')
  })

  it('shows the real configured installer URL in setup details', async () => {
    vi.resetModules()
    const real = 'https://cdn.healthflowgh.com/releases/HealthFlow-Offline-2.4.0.zip'
    vi.stubEnv('VITE_HEALTHFLOW_INSTALLER_URL', real)

    const freshConfig = await import('./branchUpdateConfig')

    expect(freshConfig.HEALTHFLOW_INSTALLER_URL_CONFIGURED).toBe(true)
    expect(freshConfig.HEALTHFLOW_INSTALLER_DETAILS_VALUE).toBe(real)
  })
})

describe('validateHealthflowInstallerUrl', () => {
  it('accepts a well-formed https URL', () => {
    expect(
      validateHealthflowInstallerUrl('https://cdn.healthflowgh.com/releases/HealthFlow-Offline.zip')
    ).toEqual({ valid: true, reason: null })
  })

  it('rejects an unparsable string as malformed', () => {
    expect(validateHealthflowInstallerUrl('not a url')).toEqual({
      valid: false,
      reason: 'malformed',
    })
  })

  it('rejects an http URL as an unsafe protocol', () => {
    expect(
      validateHealthflowInstallerUrl('http://cdn.healthflowgh.com/releases/HealthFlow-Offline.zip')
    ).toEqual({ valid: false, reason: 'unsafe-protocol' })
  })

  it('rejects a file: URL as an unsafe protocol', () => {
    expect(validateHealthflowInstallerUrl('file:///C:/HealthFlow-Installer.zip')).toEqual({
      valid: false,
      reason: 'unsafe-protocol',
    })
  })

  it('rejects a URL carrying embedded basic-auth credentials', () => {
    expect(
      validateHealthflowInstallerUrl('https://user:pass@cdn.healthflowgh.com/HealthFlow-Offline.zip')
    ).toEqual({ valid: false, reason: 'embedded-credentials' })
  })

  it('rejects a URL with a secret-looking query parameter', () => {
    expect(
      validateHealthflowInstallerUrl(
        'https://cdn.healthflowgh.com/HealthFlow-Offline.zip?branch_token=abc123'
      )
    ).toEqual({ valid: false, reason: 'embedded-credentials' })
  })

  it('accepts a URL with an unrelated, non-secret query parameter', () => {
    expect(
      validateHealthflowInstallerUrl('https://cdn.healthflowgh.com/HealthFlow-Offline.zip?version=2.4.0')
    ).toEqual({ valid: true, reason: null })
  })
})
