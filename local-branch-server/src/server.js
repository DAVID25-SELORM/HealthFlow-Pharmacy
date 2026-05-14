import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertConfiguredForServer, config, isSupabaseSyncConfigured } from './config.js'
import './db.js'
import { requireBranchToken } from './httpAuth.js'
import { createLocalClaim } from './claimsRepository.js'
import { importInventorySnapshot, searchLocalInventory } from './inventoryRepository.js'
import {
  createNhiaBatch,
  createNhiaClaim,
  exportNhiaBatch,
  getNhiaBatch,
  getNhiaClaim,
  getNhiaSettings,
  getNhiaSubmissionLogs,
  getNhiaSummary,
  listNhiaClaims,
  markNhiaClaimReady,
  saveNhiaSettings,
  submitNhiaClaim,
  submitPendingNhiaClaims,
} from './nhiaRepository.js'
import {
  getOfflineRecord,
  listOfflineRecords,
  saveOfflineRecord,
} from './offlineRecordsRepository.js'
import { createLocalSale, getRecentLocalSales } from './salesRepository.js'
import {
  getSupabaseDiagnostics,
  getSyncStatus,
  pullReferenceData,
  pullInventorySnapshot,
  syncPendingOutbox,
} from './supabaseSync.js'

assertConfiguredForServer()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendDir = path.resolve(__dirname, '..', 'public')
const frontendIndex = path.join(frontendDir, 'index.html')

const app = express()
const DEFAULT_ALLOWED_WEB_ORIGINS = new Set([
  'https://health-flow-pharmacy.vercel.app',
])

const isAllowedOrigin = (origin) => {
  if (!origin) {
    return true
  }

  if (config.allowedOrigins.length > 0) {
    return config.allowedOrigins.includes(origin.replace(/\/+$/, ''))
  }

  try {
    const url = new URL(origin)
    if (DEFAULT_ALLOWED_WEB_ORIGINS.has(origin.replace(/\/+$/, ''))) {
      return true
    }

    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.startsWith('192.168.') ||
      url.hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname)
    )
  } catch {
    return false
  }
}

app.use((request, response, next) => {
  const origin = request.get('Origin') || ''
  if (!isAllowedOrigin(origin)) {
    response.status(403).json({ error: 'Origin is not allowed for this branch server.' })
    return
  }

  response.setHeader('Access-Control-Allow-Origin', origin || 'null')
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-branch-token')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cache-Control', 'no-store')

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  next()
})

app.use(express.json({ limit: '5mb' }))

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    mode: 'local-branch-server',
    branchId: config.branchId,
    organizationId: config.organizationId,
    supabaseSyncConfigured: isSupabaseSyncConfigured(),
    sync: getSyncStatus(),
  })
})

app.get('/branch-runtime-config.js', (_request, response) => {
  response
    .type('application/javascript')
    .set('Cache-Control', 'no-store')
    .send(
      `window.__HEALTHFLOW_BRANCH_SERVER__ = ${JSON.stringify({
        enabled: true,
        url: '',
        token: config.branchServerToken,
      })};`
    )
})

app.use('/api', requireBranchToken)

app.get('/api/inventory/search', (request, response) => {
  response.json({
    data: searchLocalInventory({
      term: request.query.q || '',
      limit: request.query.limit || 30,
    }),
  })
})

app.get('/api/patients', (request, response) => {
  response.json({ data: listOfflineRecords('patients', request.query) })
})

app.post('/api/patients', (request, response, next) => {
  try {
    response.status(201).json({ data: saveOfflineRecord('patients', request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/patients/:id', (request, response, next) => {
  try {
    response.json({ data: saveOfflineRecord('patients', { ...(request.body || {}), id: request.params.id }) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/claims', (request, response) => {
  response.json({ data: listOfflineRecords('claims', request.query) })
})

app.post('/api/claims', (request, response, next) => {
  try {
    response.status(201).json({ data: saveOfflineRecord('claims', request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/claims/:id', (request, response, next) => {
  try {
    const existing = getOfflineRecord('claims', request.params.id)
    response.json({
      data: saveOfflineRecord('claims', {
        ...(existing || {}),
        ...(request.body || {}),
        id: request.params.id,
      }),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/nhis/drugs', (request, response) => {
  response.json({ data: listOfflineRecords('nhis_drugs', request.query) })
})

app.post('/api/nhis/drugs', (request, response, next) => {
  try {
    response.status(201).json({ data: saveOfflineRecord('nhis_drugs', request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/nhis/drugs/:id', (request, response, next) => {
  try {
    response.json({ data: saveOfflineRecord('nhis_drugs', { ...(request.body || {}), id: request.params.id }) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/nhis/claims', (request, response) => {
  response.json({ data: listOfflineRecords('nhis_claims', request.query) })
})

app.post('/api/nhis/claims', (request, response, next) => {
  try {
    response.status(201).json({ data: saveOfflineRecord('nhis_claims', request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/nhis/claims/:id', (request, response, next) => {
  try {
    const existing = getOfflineRecord('nhis_claims', request.params.id)
    response.json({
      data: saveOfflineRecord('nhis_claims', {
        ...(existing || {}),
        ...(request.body || {}),
        id: request.params.id,
      }),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/nhia/settings', (_request, response) => {
  response.json({ data: getNhiaSettings() })
})

app.put('/api/nhia/settings', (request, response, next) => {
  try {
    response.json({ data: saveNhiaSettings(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/nhia/summary', (_request, response) => {
  response.json(getNhiaSummary())
})

app.get('/api/nhia/claims', (request, response) => {
  response.json({
    data: listNhiaClaims({
      status: request.query.status || '',
      limit: request.query.limit || 100,
    }),
  })
})

app.post('/api/nhia/claims', (request, response, next) => {
  try {
    response.status(201).json({ data: createNhiaClaim(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/nhia/claims/:id', (request, response) => {
  const claim = getNhiaClaim(request.params.id)
  if (!claim) {
    response.status(404).json({ error: 'NHIA claim not found.' })
    return
  }

  response.json({ data: claim })
})

app.post('/api/nhia/claims/:id/ready', (request, response, next) => {
  try {
    response.json({ data: markNhiaClaimReady(request.params.id) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia/claims/:id/submit', async (request, response, next) => {
  try {
    response.json({ data: await submitNhiaClaim(request.params.id) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia/submit-pending', async (request, response, next) => {
  try {
    response.json(await submitPendingNhiaClaims({ limit: request.body?.limit || 10 }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia/batches', (request, response, next) => {
  try {
    response.status(201).json({ data: createNhiaBatch(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/nhia/batches/:id', (request, response) => {
  const batch = getNhiaBatch(request.params.id)
  if (!batch) {
    response.status(404).json({ error: 'NHIA batch not found.' })
    return
  }

  response.json({ data: batch })
})

app.get('/api/nhia/batches/:id/export', (request, response, next) => {
  try {
    const exported = exportNhiaBatch(request.params.id, request.query.format || '')
    response
      .type(exported.contentType)
      .set('Content-Disposition', `attachment; filename="${exported.fileName}"`)
      .send(exported.content)
  } catch (error) {
    next(error)
  }
})

app.get('/api/nhia/submission-logs', (request, response) => {
  response.json({ data: getNhiaSubmissionLogs({ limit: request.query.limit || 50 }) })
})

app.get('/api/suppliers', (request, response) => {
  response.json({ data: listOfflineRecords('suppliers', request.query) })
})

app.post('/api/suppliers', (request, response, next) => {
  try {
    response.status(201).json({ data: saveOfflineRecord('suppliers', request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/suppliers/:id', (request, response, next) => {
  try {
    response.json({ data: saveOfflineRecord('suppliers', { ...(request.body || {}), id: request.params.id }) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/purchases', (request, response) => {
  response.json({ data: listOfflineRecords('purchases', request.query) })
})

app.post('/api/purchases', (request, response, next) => {
  try {
    response.status(201).json({ data: saveOfflineRecord('purchases', request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/purchases/:id', (request, response, next) => {
  try {
    const existing = getOfflineRecord('purchases', request.params.id)
    response.json({
      data: saveOfflineRecord('purchases', {
        ...(existing || {}),
        ...(request.body || {}),
        id: request.params.id,
      }),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/inventory/import', (request, response, next) => {
  try {
    response.status(201).json(importInventorySnapshot(request.body?.drugs || []))
  } catch (error) {
    next(error)
  }
})

app.post('/api/sales', (request, response, next) => {
  try {
    const result = createLocalSale(request.body || {})
    const claimResult = request.body?.claimPayload
      ? createLocalClaim(request.body.claimPayload, result.sale)
      : null
    const nhiaClaim = request.body?.nhiaClaimPayload
      ? createNhiaClaim(request.body.nhiaClaimPayload, result.sale)
      : null
    response.status(201).json({
      ...result,
      claim: claimResult?.claim || null,
      claimNumber: claimResult?.claimNumber || null,
      nhiaClaim,
      nhiaClaimNumber: nhiaClaim?.claimNumber || null,
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/sales/recent', (request, response) => {
  response.json({ data: getRecentLocalSales(request.query.limit || 20) })
})

app.get('/api/sync/status', (_request, response) => {
  response.json(getSyncStatus())
})

app.post('/api/sync/run', async (_request, response, next) => {
  try {
    response.json(await syncPendingOutbox())
  } catch (error) {
    next(error)
  }
})

app.post('/api/sync/pull-inventory', async (_request, response, next) => {
  try {
    response.json(await pullInventorySnapshot())
  } catch (error) {
    next(error)
  }
})

app.post('/api/sync/pull-reference-data', async (_request, response, next) => {
  try {
    response.json(await pullReferenceData())
  } catch (error) {
    next(error)
  }
})

app.get('/api/sync/diagnostics', async (_request, response, next) => {
  try {
    response.json(await getSupabaseDiagnostics())
  } catch (error) {
    next(error)
  }
})

if (fs.existsSync(frontendIndex)) {
  app.use(express.static(frontendDir, {
    index: false,
    maxAge: '1h',
  }))

  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next()
      return
    }

    response.sendFile(frontendIndex)
  })
}

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(400).json({
    error: error.message || 'Request failed.',
    cause: error.cause?.message || null,
    code: error.cause?.code || error.code || null,
  })
})

app.listen(config.port, () => {
  console.log(`HealthFlow local branch server listening on http://localhost:${config.port}`)
})
