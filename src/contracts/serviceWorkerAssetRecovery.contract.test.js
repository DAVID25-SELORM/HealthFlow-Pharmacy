import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const serviceWorker = readFileSync(resolve(process.cwd(), 'public/service-worker.js'), 'utf8')
const registration = readFileSync(resolve(process.cwd(), 'src/registerServiceWorker.js'), 'utf8')
const deploymentRecovery = readFileSync(resolve(process.cwd(), 'public/deployment-recovery.js'), 'utf8')
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

describe('service worker deployment asset recovery', () => {
  it('falls back to a cached hashed script or stylesheet when a new deployment removes it', () => {
    expect(serviceWorker).toContain("if (cachedResponse)")
    expect(serviceWorker).toContain('return cachedResponse')
    expect(serviceWorker).toContain("['script', 'style'].includes(request.destination)")
  })

  it('notifies the client about uncached deployment asset misses', () => {
    expect(serviceWorker).toContain("type: 'HEALTHFLOW_ASSET_MISS'")
    expect(serviceWorker).toContain('status: response.status')
  })

  it('performs a guarded refresh so the browser loads the current deployment manifest', () => {
    expect(registration).toContain("event.data?.type !== 'HEALTHFLOW_ASSET_MISS'")
    expect(registration).toContain('ASSET_RECOVERY_RELOAD_COOLDOWN_MS = 30_000')
    expect(registration).toContain('window.location.reload()')
  })

  it('loads a stable pre-entry recovery bootstrap for stale hashed assets', () => {
    expect(indexHtml).toContain('<script src="/deployment-recovery.js"></script>')
    expect(deploymentRecovery).toContain("window.addEventListener('vite:preloadError'")
    expect(deploymentRecovery).toContain("window.addEventListener('unhandledrejection'")
    expect(deploymentRecovery).toContain("window.addEventListener('error'")
    expect(deploymentRecovery).toContain("name.startsWith('healthflow-')")
    expect(deploymentRecovery).toContain("nextUrl.searchParams.set('__healthflow_refresh'")
    expect(deploymentRecovery).toContain('RELOAD_COOLDOWN_MS = 30_000')
  })
})
