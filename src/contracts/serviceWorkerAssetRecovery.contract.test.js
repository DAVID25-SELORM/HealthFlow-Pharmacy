import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const serviceWorker = readFileSync(resolve(process.cwd(), 'public/service-worker.js'), 'utf8')
const registration = readFileSync(resolve(process.cwd(), 'src/registerServiceWorker.js'), 'utf8')

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
})
