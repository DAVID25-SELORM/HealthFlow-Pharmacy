import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertConfiguredForServer, config, isSupabaseSyncConfigured } from './config.js'
import { closeDatabase } from './db.js'
import { createClaimBridgeRouter } from './claimBridge.js'
import { requireBranchToken } from './httpAuth.js'
import { createLocalClaim } from './claimsRepository.js'
import { importInventorySnapshot, listLocalInventory, searchLocalInventory } from './inventoryRepository.js'
import {
  createNhiaBatch,
  createNhiaClaim,
  exportNhiaBatch,
  generateNhiaCcCode,
  getNhiaBatch,
  getNhiaClaim,
  getNhiaSettings,
  getNhiaSubmissionLogs,
  getNhiaSummary,
  listNhiaClaims,
  markNhiaClaimReady,
  saveNhiaSettings,
  submitNhiaDirectPayload,
  submitNhiaClaim,
  submitPendingNhiaClaims,
} from './nhiaRepository.js'
import {
  getOfflineRecord,
  listOfflineRecords,
  saveOfflineRecord,
} from './offlineRecordsRepository.js'
import {
  getPaymentStatus,
  handleHubtelWebhook,
  handlePaystackWebhook,
  initiatePayment,
} from './paymentsRepository.js'
import { createLocalSale, getLocalSale, getRecentLocalSales } from './salesRepository.js'
import {
  getSupabaseDiagnostics,
  getSyncStatus,
  pullReferenceData,
  pullInventorySnapshot,
  syncPendingOutbox,
} from './supabaseSync.js'
import { startSyncWorker, stopSyncWorker, waitForSyncWorkerIdle } from './syncWorker.js'

assertConfiguredForServer()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendDir = path.resolve(__dirname, '..', 'public')
const frontendIndex = path.join(frontendDir, 'index.html')

const app = express()
const DEFAULT_ALLOWED_WEB_ORIGINS = new Set([
  'https://health-flow-pharmacy.vercel.app',
])
const isDevelopment = process.env.NODE_ENV !== 'production'

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

    if (!isDevelopment) {
      return false
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
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-branch-token, x-paystack-signature, x-hubtel-signature, x-hubtel-webhook-signature, x-signature'
  )
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cache-Control', 'no-store')

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  next()
})

app.use(express.json({
  limit: '5mb',
  verify: (request, _response, buffer) => {
    request.rawBody = buffer.toString('utf8')
  },
}))

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
      })};`
    )
})

if (config.claimBridge.enabled) {
  app.use(config.claimBridge.publicPath, createClaimBridgeRouter())
  console.log(`CLAIM-it production bridge mounted at ${config.claimBridge.publicPath}`)
}

app.post('/api/payments/webhook/hubtel', async (request, response, next) => {
  try {
    await handleHubtelWebhook({
      rawBody: request.rawBody || '',
      headers: request.headers,
      body: request.body || {},
    })
    response.status(200).json({ received: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/webhook/paystack', async (request, response, next) => {
  try {
    await handlePaystackWebhook({
      rawBody: request.rawBody || '',
      headers: request.headers,
      body: request.body || {},
    })
    response.status(200).json({ received: true })
  } catch (error) {
    next(error)
  }
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

app.get('/api/inventory', (request, response) => {
  response.json({
    data: listLocalInventory({
      branchId: request.query.branchId || config.branchId || '',
      limit: request.query.limit || 5000,
    }),
  })
})

app.get('/api/pos/bootstrap', (request, response) => {
  const inventoryLimit = Math.min(Math.max(Number(request.query.inventoryLimit) || 30, 1), 100)
  const patientLimit = Math.min(Math.max(Number(request.query.patientLimit) || 25, 1), 500)
  const recentLimit = Math.min(Math.max(Number(request.query.recentLimit) || 8, 1), 50)
  const sync = getSyncStatus()

  response.json({
    data: {
      inventory: searchLocalInventory({
        term: request.query.inventoryTerm || '',
        limit: inventoryLimit,
      }),
      patients: listOfflineRecords('patients', {
        limit: patientLimit,
        searchTerm: request.query.patientTerm || '',
      }),
      recentSales: getRecentLocalSales(recentLimit),
      nhiaSettings: getNhiaSettings(),
      branchId: config.branchId,
      organizationId: config.organizationId,
      sync,
      cache: {
        inventory: sync.inventory,
        nhia: getNhiaSummary(),
      },
    },
  })
})

// ✅ OFFLINE-FIRST PATCH START
app.get('/api/preload', (request, response) => {
  response.json({
    data: {
      patients: listOfflineRecords('patients', { limit: request.query.patientLimit || 500 }),
      inventory: listLocalInventory({
        branchId: request.query.branchId || config.branchId || '',
        limit: request.query.inventoryLimit || 5000,
      }),
      claims: listOfflineRecords('claims', { limit: request.query.claimLimit || 500 }),
      purchases: listOfflineRecords('purchases', { limit: request.query.purchaseLimit || 500 }),
      nhisClaims: listOfflineRecords('nhis_claims', { limit: request.query.nhisClaimLimit || 500 }),
      sync: getSyncStatus(),
    },
  })
})
// ✅ OFFLINE-FIRST PATCH END

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

app.get('/api/nhia-config', (_request, response) => {
  response.json({ data: getNhiaSettings() })
})

app.post('/api/nhia-config', (request, response, next) => {
  try {
    response.json({ data: saveNhiaSettings(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/nhia-config', (request, response, next) => {
  try {
    response.json({ data: saveNhiaSettings(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia-config/test', (_request, response) => {
  response.json({ data: { ok: true, message: 'NHIA configuration route is available.' } })
})

app.post('/api/nhia/cc-code', async (request, response, next) => {
  try {
    response.json({ data: await generateNhiaCcCode(request.body || {}) })
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

// Unified NHIS claim route for both community pharmacies (medicines only) and hospital pharmacies (medicines + G-DRG services).
// Community pharmacy: organizationType omitted or 'pharmacy' — diagnosis optional, no service lines.
// Hospital pharmacy:  organizationType 'hospital' — diagnosis required, services array included.
app.post('/api/nhis/pharmacy-claim', async (request, response, next) => {
  try {
    const body = request.body || {}
    const {
      patientName, memberNumber, hin, schemeCode, gender, dateOfBirth,
      dispensingDate, referralFacility, diagnosis, medicines = [], services = [],
      claimPeriod, claimsOfficerName, organizationType,
    } = body

    const isHospital = (organizationType || '').toLowerCase() === 'hospital'

    if (!patientName || !memberNumber || !medicines.length) {
      response.status(400).json({ error: 'patientName, memberNumber, and at least one medicine are required.' })
      return
    }
    if (isHospital && !diagnosis) {
      response.status(400).json({ error: 'diagnosis is required for hospital claims.' })
      return
    }

    const medicinesTotal = medicines.reduce((sum, m) => sum + Number(m.totalPrice || 0), 0)
    const servicesTotal = isHospital ? services.reduce((sum, s) => sum + Number(s.totalAmount || 0), 0) : 0
    const totalAmount = medicinesTotal + servicesTotal

    // Generate CC code unless one was supplied by the caller.
    let ccCode = body.ccCode || null
    if (!ccCode) {
      const ccResult = await generateNhiaCcCode({
        patientName,
        memberNumber,
        hin,
        diagnosis: isHospital ? diagnosis : undefined,
        serviceDate: dispensingDate,
        totalAmount,
        organizationType: isHospital ? 'hospital' : 'pharmacy',
      })
      ccCode = ccResult.ccCode || null
    }

    // Persist the claim locally.
    const claim = createNhiaClaim({
      member_number: memberNumber,
      hin,
      surname: patientName.split(' ').slice(-1)[0] || patientName,
      other_names: patientName.split(' ').slice(0, -1).join(' ') || patientName,
      gender,
      date_of_birth: dateOfBirth,
      cc_code: ccCode,
      diagnosis: isHospital ? diagnosis : null,
      organization_type: isHospital ? 'hospital' : 'pharmacy',
      service_date: dispensingDate,
      referring_facility: referralFacility || null,
      scheme_code: schemeCode || null,
      claim_period: claimPeriod || null,
      claims_officer_name: claimsOfficerName || null,
      total_amount: totalAmount,
      items: medicines.map((m) => ({
        nhia_code: m.nhiaCode || m.code,
        description: m.name,
        quantity: Number(m.quantity),
        unit_price: Number(m.unitPrice),
        total_price: Number(m.totalPrice),
        unit: m.unit || '',
        dosage_form: m.dosageForm || '',
        strength: m.strength || '',
        dispensary_date: dispensingDate,
      })),
      // Hospital service/G-DRG lines stored in payload for branch server persistence.
      services: isHospital ? services.map((s) => ({
        gdrg_code: s.gdrgCode || s.gdrg_code,
        description: s.description,
        age_band: s.ageBand || s.age_band || null,
        unit_price: Number(s.unitPrice || s.unit_price || 0),
        quantity: Number(s.quantity || 1),
        total_amount: Number(s.totalAmount || s.total_amount || 0),
        facility_group: s.facilityGroup || s.facility_group || null,
        catering_option: s.cateringOption || s.catering_option || null,
        mdc: s.mdc || null,
        service_date: dispensingDate,
      })) : [],
    })

    // Immediately submit to CLAIM-it.
    const submitted = await submitNhiaClaim(claim.id)
    response.status(201).json({ data: submitted })
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

app.post('/api/nhia/direct-submit', async (request, response, next) => {
  try {
    response.json({
      data: await submitNhiaDirectPayload({
        payload: request.body?.payload,
        claimIds: request.body?.claimIds || [],
        action: request.body?.action || 'nhis.direct_submit',
      }),
    })
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

app.post('/api/payments/initiate', async (request, response, next) => {
  try {
    response.status(201).json({ data: await initiatePayment(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/payments/status/:reference', async (request, response, next) => {
  try {
    const payment = await getPaymentStatus(request.params.reference)
    if (!payment) {
      response.status(404).json({ error: 'Payment reference not found.' })
      return
    }
    response.json({ data: payment })
  } catch (error) {
    next(error)
  }
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

app.get('/api/sales/:id', (request, response) => {
  const sale = getLocalSale(request.params.id)
  if (!sale) {
    response.status(404).json({ error: 'Local sale not found.' })
    return
  }

  const patient = sale.patientId ? getOfflineRecord('patients', sale.patientId) : null
  response.json({
    data: {
      ...sale,
      patients: patient,
      sale_items: sale.items,
    },
  })
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

const server = app.listen(config.port, () => {
  console.log(`HealthFlow local branch server listening on http://localhost:${config.port}`)
  startSyncWorker()
})

// ✅ SQLITE CORRUPTION FIX START
let isShuttingDown = false

const shutdownGracefully = async (signal) => {
  if (isShuttingDown) {
    return
  }

  isShuttingDown = true
  console.log(`${signal} received. Shutting down HealthFlow local branch server...`)
  stopSyncWorker()

  try {
    await Promise.race([
      waitForSyncWorkerIdle(),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ])
  } catch (error) {
    console.error('Active sync failed during shutdown:', error)
  }

  await new Promise((resolve) => {
    server.close(() => resolve())
    setTimeout(resolve, 5000)
  })

  closeDatabase()
  process.exit(0)
}

process.on('SIGINT', () => {
  shutdownGracefully('SIGINT').catch((error) => {
    console.error('Graceful shutdown failed:', error)
    process.exit(1)
  })
})

process.on('SIGTERM', () => {
  shutdownGracefully('SIGTERM').catch((error) => {
    console.error('Graceful shutdown failed:', error)
    process.exit(1)
  })
})
// ✅ SQLITE CORRUPTION FIX END
