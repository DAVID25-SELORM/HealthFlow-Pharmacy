import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from './config.js'
import { createClaimBridgeRouter } from './claimBridge.js'
import { registerSpaFallback } from './spaFallback.js'

// These tests start real Express servers so that a route path Express cannot parse
// (Express 5 rejects a bare '*') fails here instead of stopping a branch server at startup.

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server))
})

const close = (server) => new Promise((resolve) => server.close(resolve))

describe('single-page-app fallback route', () => {
  let tempDir
  let server
  let baseUrl

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-spa-'))
    const indexPath = path.join(tempDir, 'index.html')
    fs.writeFileSync(indexPath, '<!doctype html><title>HealthFlow</title>')

    const app = express()
    registerSpaFallback(app, indexPath)
    server = await listen(app)
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  afterAll(async () => {
    await close(server)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('serves the app page for the root and for browser routes', async () => {
    for (const route of ['/', '/inventory', '/claims/123/edit']) {
      const response = await fetch(`${baseUrl}${route}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toContain('<title>HealthFlow</title>')
    }
  })

  it('leaves /api/ paths to the API routes', async () => {
    const response = await fetch(`${baseUrl}/api/not-a-route`)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<title>HealthFlow</title>')
  })
})

describe('CLAIM-it bridge router', () => {
  let server
  let baseUrl
  let savedUpstream

  beforeAll(async () => {
    savedUpstream = config.claimBridge.upstreamBaseUrl
    config.claimBridge.upstreamBaseUrl = ''

    const app = express()
    app.use('/claimit', createClaimBridgeRouter())
    server = await listen(app)
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  afterAll(async () => {
    config.claimBridge.upstreamBaseUrl = savedUpstream
    await close(server)
  })

  it('mounts and answers any path and method through its catch-all route', async () => {
    for (const [method, route] of [['GET', '/claimit/anything/at/all'], ['POST', '/claimit/submit']]) {
      const response = await fetch(`${baseUrl}${route}`, { method })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'CLAIM-it upstream base URL is not configured.' })
    }
  })
})

describe('route path strings', () => {
  it('never register a bare "*" path, which Express 5 cannot parse', () => {
    const sourceDir = path.resolve('local-branch-server/src')
    const offenders = []
    const routeCall = /\.(?:all|get|post|put|patch|delete|use|options|head)\(\s*(['"`])\*\1/

    for (const entry of fs.readdirSync(sourceDir)) {
      if (!entry.endsWith('.js') || entry.endsWith('.test.js')) continue
      fs.readFileSync(path.join(sourceDir, entry), 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (routeCall.test(line)) offenders.push(`${entry}:${index + 1}`)
      })
    }

    expect(offenders).toEqual([])
  }, 30000)
})
