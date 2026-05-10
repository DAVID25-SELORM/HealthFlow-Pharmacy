import express from 'express'
import { assertConfiguredForServer, config, isSupabaseSyncConfigured } from './config.js'
import './db.js'
import { requireBranchToken } from './httpAuth.js'
import { createLocalClaim } from './claimsRepository.js'
import { importInventorySnapshot, searchLocalInventory } from './inventoryRepository.js'
import { createLocalSale, getRecentLocalSales } from './salesRepository.js'
import { getSyncStatus, pullInventorySnapshot, syncPendingOutbox } from './supabaseSync.js'

assertConfiguredForServer()

const app = express()

app.use((request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', request.get('Origin') || '*')
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-branch-token')

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

app.use('/api', requireBranchToken)

app.get('/api/inventory/search', (request, response) => {
  response.json({
    data: searchLocalInventory({
      term: request.query.q || '',
      limit: request.query.limit || 30,
    }),
  })
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
    response.status(201).json({
      ...result,
      claim: claimResult?.claim || null,
      claimNumber: claimResult?.claimNumber || null,
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

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(400).json({ error: error.message || 'Request failed.' })
})

app.listen(config.port, () => {
  console.log(`HealthFlow local branch server listening on http://localhost:${config.port}`)
})
