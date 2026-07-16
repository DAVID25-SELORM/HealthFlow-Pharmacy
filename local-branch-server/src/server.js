import express from 'express'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertConfiguredForServer, config, isSupabaseSyncConfigured } from './config.js'
import { backupDatabase, closeDatabase, getDatabaseStatus } from './db.js'
import { normalizePharmacyClaimLines } from './claimPricing.js'
import { createClaimBridgeRouter } from './claimBridge.js'
import { applyNhisCatalogPricing } from './nhisCatalogPricing.js'
import {
  getBranchAuthCookie,
  issueBranchUserSession,
  issueOfflineBranchUserSession,
  requireBranchToken,
  requireBranchUserSession,
} from './httpAuth.js'
import {
  authenticateOfflinePin,
  auditOfflineLoginRateLimited,
  enrollOfflinePin,
  listOfflineAccessUsers,
  listOfflineAuthAudit,
  recordLocalAuditEvent,
  resetOfflinePin,
  setOfflineAccess,
} from './offlineAuthRepository.js'
import {
  BRANCH_JSON_BODY_LIMIT,
  getBranchRequestErrorResponse,
} from './requestLimits.js'
import { authorizeLocalOperationalRoute } from './localAuthorization.js'
import { createOfflineLoginRateLimiter } from './offlineLoginRateLimit.js'
import { getPublicTlsStatus, inspectTlsRuntime, saveCloudSyncSettings, saveTlsSettings } from './tlsSettings.js'
import {
  createWorkstationEnrollmentToken,
  enrollWorkstation,
  listAuthorizedWorkstations,
  requireAuthorizedWorkstation,
  revokeAuthorizedWorkstation,
} from './workstationRepository.js'
import { createLocalClaim } from './claimsRepository.js'
import { deleteLocalInventoryDrug, importInventorySnapshot, listLocalInventory, searchLocalInventory } from './inventoryRepository.js'
import {
  createNhiaBatch,
  createNhiaClaim,
  exportNhiaBatch,
  generateNhiaCcCode,
  getNhiaBatch,
  getNhiaClaim,
  getNhiaConfigurationHealth,
  getNhiaSettings,
  getNhiaSubmissionLogs,
  getNhiaSummary,
  listNhiaClaims,
  lookupNhiaMember,
  markNhiaClaimReady,
  repairMissingNhiaClaimIds,
  saveNhiaSettings,
  submitNhiaDirectPayload,
  submitNhiaClaim,
  submitPendingNhiaClaims,
} from './nhiaRepository.js'
import {
  deleteOfflineRecord,
  getOfflineRecord,
  listOfflineRecords,
  saveOfflineRecord,
} from './offlineRecordsRepository.js'
import {
  buildMcaEditReopenFields,
  canReopenMcaEditWindow,
  isMcaEditWindowOpen,
} from './mcaEditWindow.js'
import {
  getPaymentStatus,
  handleHubtelWebhook,
  handlePaystackWebhook,
  initiatePayment,
} from './paymentsRepository.js'
import { getLocalReportBundle } from './reportsRepository.js'
import {
  closeLocalPosSession,
  createLocalSale,
  getLocalSale,
  getOpenLocalPosSession,
  getRecentLocalSales,
  openLocalPosSession,
} from './salesRepository.js'
import {
  getSupabaseDiagnostics,
  getSyncStatus,
  pullReferenceData,
  pullInventorySnapshot,
  repairFailedSync,
  syncPendingOutbox,
} from './supabaseSync.js'
import { startSyncWorker, stopSyncWorker, waitForSyncWorkerIdle } from './syncWorker.js'
import { getOfflineReadiness } from './offlineReadiness.js'
import {
  checkForUpdates,
  getUpdateStatus,
  installAvailableUpdate,
  startUpdateScheduler,
  stopUpdateScheduler,
} from './updateManager.js'

assertConfiguredForServer()
const tlsRuntime = inspectTlsRuntime()
config.tls.enabled = tlsRuntime.ready
const effectiveHost = tlsRuntime.ready ? config.host : '127.0.0.1'
if (!tlsRuntime.ready) {
  console.warn(`TLS Not Configured: ${tlsRuntime.warning} Starting in local-only mode.`)
  if (tlsRuntime.error) console.warn(`TLS certificate error: ${tlsRuntime.error}`)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendDir = path.resolve(__dirname, '..', 'public')
const frontendIndex = path.join(frontendDir, 'index.html')
const noStoreFrontendFiles = new Set([
  'index.html',
  'service-worker.js',
  'manifest.webmanifest',
  'branch-runtime-config.js',
])
const NHIS_SERVICE_TIME_ZONE = 'Africa/Accra'

const toNhisCalendarDate = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: NHIS_SERVICE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const part = (type) => parts.find((item) => item.type === type)?.value || ''
    return [part('year'), part('month'), part('day')].filter(Boolean).join('-')
  } catch {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')
  }
}

const normalizeNhiaServiceDate = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) {
    const [, day, month, year] = dmy
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return toNhisCalendarDate(raw)
}

const setFrontendCacheHeaders = (response, filePath) => {
  const fileName = path.basename(filePath)
  if (noStoreFrontendFiles.has(fileName)) {
    response.setHeader('Cache-Control', 'no-store')
    return
  }

  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  }
}

const app = express()
if (config.trustProxy) {
  app.set('trust proxy', config.trustProxy)
}
const rateLimitBuckets = new Map()

const shouldRateLimit = (request) =>
  (request.path.startsWith('/api/') && request.path !== '/api/auth/offline-login') ||
  request.path === config.claimBridge.publicPath ||
  request.path.startsWith(`${config.claimBridge.publicPath}/`)

const rateLimitRequests = (request, response, next) => {
  if (!config.rateLimit.enabled || !shouldRateLimit(request)) {
    next()
    return
  }

  const now = Date.now()
  const windowMs = config.rateLimit.windowMs
  const ip = request.ip || request.socket?.remoteAddress || 'unknown'
  const key = `${ip}:${request.path}`
  const bucket = rateLimitBuckets.get(key)

  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs })
    next()
    return
  }

  bucket.count += 1
  if (bucket.count > config.rateLimit.maxRequests) {
    response.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000))
    response.status(429).json({ error: 'Too many requests. Please try again shortly.' })
    return
  }

  next()
}

app.use(rateLimitRequests)

setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now >= bucket.resetAt) {
      rateLimitBuckets.delete(key)
    }
  }
  rateLimitOfflineLogin.prune()
}, Math.max(config.rateLimit.windowMs, 60000)).unref()
// ✅ STATIC FRONTEND PATCH START
if (fs.existsSync(frontendIndex)) {
  app.use(express.static(frontendDir, {
    index: false,
    maxAge: 0,
    setHeaders: setFrontendCacheHeaders,
  }))
}
// ✅ STATIC FRONTEND PATCH END

const DEFAULT_ALLOWED_WEB_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

const isLoopbackOrigin = (url) =>
  url.hostname === 'localhost' ||
  url.hostname === '127.0.0.1'

const isLanOrigin = (url) =>
  url.hostname.startsWith('192.168.') ||
  url.hostname.startsWith('10.') ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname)

const isAllowedOrigin = (origin, request) => {
  if (!origin) {
    return true
  }

  if (origin === 'null') {
    return config.allowNullOrigin
  }

  const normalizedOrigin = origin.replace(/\/+$/, '')
  const requestOrigin = `${request.protocol}://${request.get('host')}`.replace(/\/+$/, '')
  if (normalizedOrigin === requestOrigin) {
    return true
  }

  try {
    const url = new URL(normalizedOrigin)

    if (isLoopbackOrigin(url)) {
      return true
    }

    if (config.allowLanOrigins && isLanOrigin(url)) {
      return true
    }
  } catch {
    return false
  }

  if (DEFAULT_ALLOWED_WEB_ORIGINS.has(normalizedOrigin)) {
    return true
  }

  if (config.allowedOrigins.length > 0) {
    return config.allowedOrigins.includes(normalizedOrigin)
  }

  return false
}

app.use((request, response, next) => {
  const origin = request.get('Origin') || ''
  if (!isAllowedOrigin(origin, request)) {
    response.status(403).json({ error: 'Origin is not allowed for this branch server.' })
    return
  }

  response.setHeader('Access-Control-Allow-Origin', origin || '*')
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-branch-token, x-branch-user-session, x-healthflow-workstation-id, x-healthflow-workstation-secret, x-paystack-signature, x-hubtel-signature, x-hubtel-webhook-signature, x-signature'
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
  limit: BRANCH_JSON_BODY_LIMIT,
  verify: (request, _response, buffer) => {
    request.rawBody = buffer.toString('utf8')
  },
}))

app.get('/health', requireBranchToken, (_request, response) => {
  const database = getDatabaseStatus()
  const nhia = getNhiaConfigurationHealth()
  response.json({
    ok: database.ok,
    mode: 'local-branch-server',
    version: getUpdateStatus().currentVersion,
    supabaseSyncConfigured: isSupabaseSyncConfigured(),
    database: {
      integrity: database.integrity,
      sizeBytes: database.estimatedSizeBytes,
    },
    tls: getPublicTlsStatus(tlsRuntime),
    nhia,
  })
})

app.get('/branch-runtime-config.js', (request, response) => {
  const sameOriginRequest = String(request.get('Sec-Fetch-Site') || '').toLowerCase() === 'same-origin'
  if (sameOriginRequest) {
    response.setHeader('Set-Cookie', getBranchAuthCookie())
  }
  response
    .type('application/javascript')
    .set('Cache-Control', 'no-store')
    .send(
      `window.__HEALTHFLOW_BRANCH_SERVER__ = ${JSON.stringify({
        enabled: true,
        url: '',
        token: '',
        organizationId: config.organizationId,
        branchId: config.branchId,
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

app.post('/api/workstations/enroll', (request, response, next) => {
  try {
    response.status(201).json({
      data: enrollWorkstation({
        enrollmentToken: request.body?.enrollmentToken,
        computerName: request.body?.computerName,
        ipAddress: request.ip,
      }),
    })
  } catch (error) {
    next(error)
  }
})

app.use('/api', requireBranchToken)
app.use('/api', requireAuthorizedWorkstation)

const requireBranchClaimsAccess = (request, response, next) => {
  const role = String(request.branchUser?.role || '').toLowerCase()
  const allowed =
    ['admin', 'super_admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer'].includes(role) ||
    (role !== 'assistant' && request.branchUser?.canManageClaims === true)
  if (!allowed) {
    response.status(403).json({ error: 'Only claims staff can perform this action.' })
    return
  }
  next()
}

const requireBranchAdminAccess = (request, response, next) => {
  if (!['admin', 'super_admin'].includes(String(request.branchUser?.role || '').toLowerCase())) {
    response.status(403).json({ error: 'Only an administrator can perform this action.' })
    return
  }
  next()
}

app.post('/api/auth/user-session', async (request, response, next) => {
  try {
    const authorization = String(request.get('Authorization') || '')
    const accessToken = authorization.replace(/^Bearer\s+/i, '').trim()
    if (!accessToken) {
      response.status(401).json({ error: 'A signed-in Supabase session is required.' })
      return
    }
    response.json({
      data: await issueBranchUserSession({
        accessToken,
        activeRole: request.body?.activeRole,
      }),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/offline-pin/enroll', async (request, response, next) => {
  try {
    const authorization = String(request.get('Authorization') || '')
    const accessToken = authorization.replace(/^Bearer\s+/i, '').trim()
    if (!accessToken) {
      response.status(401).json({ error: 'Online staff verification is required to enroll an offline PIN.' })
      return
    }
    const verified = await issueBranchUserSession({
      accessToken,
      activeRole: request.body?.activeRole,
    })
    response.json({
      data: enrollOfflinePin({
        userId: verified.userId,
        pin: request.body?.pin,
        ipAddress: request.ip,
      }),
    })
  } catch (error) {
    next(error)
  }
})

const rateLimitOfflineLogin = createOfflineLoginRateLimiter({
  ...config.offlineLoginRateLimit,
  auditRateLimited: auditOfflineLoginRateLimited,
})

app.post('/api/auth/offline-login', rateLimitOfflineLogin, (request, response, next) => {
  try {
    const user = authenticateOfflinePin({
      email: request.body?.email,
      pin: request.body?.pin,
      ipAddress: request.ip,
    })
    response.json({
      data: {
        ...issueOfflineBranchUserSession(user, request.body?.activeRole),
        organization: user.organization,
        branch: user.branch,
      },
    })
  } catch (error) {
    next(error)
  }
})

app.get(
  '/api/auth/offline-access',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (_request, response) => {
    response.json({ data: listOfflineAccessUsers() })
  }
)

app.patch(
  '/api/auth/offline-access/:userId',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (request, response, next) => {
    try {
      response.json({
        data: setOfflineAccess({
          targetUserId: request.params.userId,
          enabled: request.body?.enabled === true,
          actorUserId: request.branchUser.userId,
          ipAddress: request.ip,
        }),
      })
    } catch (error) {
      next(error)
    }
  }
)

app.post(
  '/api/auth/offline-access/:userId/reset',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (request, response, next) => {
    try {
      response.json({
        data: resetOfflinePin({
          targetUserId: request.params.userId,
          actorUserId: request.branchUser.userId,
          ipAddress: request.ip,
        }),
      })
    } catch (error) {
      next(error)
    }
  }
)

app.get(
  '/api/auth/offline-audit',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (request, response) => {
    response.json({ data: listOfflineAuthAudit(request.query.limit) })
  }
)

app.get(
  '/api/tls/status',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (_request, response) => {
    response.json({ data: getPublicTlsStatus(tlsRuntime) })
  }
)

app.patch(
  '/api/tls/settings',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (request, response, next) => {
    try {
      response.json({ data: saveTlsSettings(request.body || {}) })
    } catch (error) {
      next(error)
    }
  }
)

app.post(
  '/api/deployment/cloud-config',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (request, response, next) => {
    try {
      const saved = saveCloudSyncSettings(request.body || {})
      response.json({ data: saved })
      setTimeout(() => {
        const restartScript = path.join(path.resolve(__dirname, '..'), 'scripts', 'restart-service.ps1')
        const child = spawn('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', restartScript,
        ], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        child.unref()
      }, 500).unref()
    } catch (error) {
      next(error)
    }
  }
)

const getInstallRoot = () => path.resolve(__dirname, '..', '..')
const getWorkstationBundlePath = () =>
  path.join(getInstallRoot(), 'HealthFlow-Connect-This-Computer.zip')

app.get(
  '/api/deployment/status',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (_request, response) => {
    const tls = getPublicTlsStatus(tlsRuntime)
    response.json({
      data: {
        tls,
        workstationBundleReady: fs.existsSync(getWorkstationBundlePath()),
        workstationBundleName: 'HealthFlow-Connect-This-Computer.zip',
        workstations: listAuthorizedWorkstations(),
        completionChecks: {
          serviceRunning: true,
          tlsReady: tls.ready,
          databaseHealthy: getDatabaseStatus().ok,
          syncConfigured: isSupabaseSyncConfigured(),
        },
      },
    })
  }
)

app.post(
  '/api/deployment/workstation-bundle',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (_request, response) => {
    const enrollment = createWorkstationEnrollmentToken()
    const builder = path.join(path.resolve(__dirname, '..'), 'scripts', 'build-workstation-bundle.ps1')
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', builder,
      '-InstallRoot', getInstallRoot(),
      '-EnrollmentToken', enrollment.token,
    ], {
      windowsHide: true,
      stdio: 'ignore',
    })
    const bundlePath = getWorkstationBundlePath()
    if (!fs.existsSync(bundlePath)) {
      response.status(404).json({ error: 'Workstation enrollment bundle has not been generated.' })
      return
    }
    response.download(bundlePath, 'HealthFlow-Connect-This-Computer.zip')
  }
)

app.post(
  '/api/deployment/tls/renew',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (_request, response) => {
    const scriptPath = path.join(path.resolve(__dirname, '..'), 'scripts', 'provision-facility-tls.ps1')
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-InstallRoot', getInstallRoot(),
      '-LanHostname', config.tls.lanHostname,
      ...(config.tls.lanIp ? ['-LanIp', config.tls.lanIp] : []),
      '-Force',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    response.status(202).json({
      data: { started: true, message: 'TLS renewal started. The local server will restart when complete.' },
    })
  }
)

app.delete(
  '/api/deployment/workstations/:id',
  requireBranchUserSession,
  requireBranchAdminAccess,
  (request, response, next) => {
    try {
      response.json({
        data: revokeAuthorizedWorkstation({
          id: request.params.id,
          actorUserId: request.branchUser.userId,
        }),
      })
    } catch (error) {
      next(error)
    }
  }
)

// Every operational API after the authentication endpoints requires a current,
// locally revalidated staff identity. This makes account disablement, offline
// revocation, PIN reset, and role changes effective across all workstations.
app.use('/api', requireBranchUserSession, requireAuthorizedWorkstation, authorizeLocalOperationalRoute)

app.get('/api/database/status', (_request, response, next) => {
  try {
    response.json({ data: getDatabaseStatus() })
  } catch (error) {
    next(error)
  }
})

app.get('/api/offline/readiness', (_request, response, next) => {
  try {
    response.json({ data: getOfflineReadiness({ frontendIndex }) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/database/backup', (request, response, next) => {
  try {
    const label = String(request.body?.label || 'manual').trim() || 'manual'
    const backup = backupDatabase(label.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 64))
    response.status(201).json({ data: { backup, status: getDatabaseStatus() } })
  } catch (error) {
    next(error)
  }
})

app.get('/api/database/backups/:fileName/download', (request, response, next) => {
  try {
    const backupDir = path.join(path.dirname(config.sqlitePath), 'backups')
    const fileName = path.basename(String(request.params.fileName || ''))
    const filePath = path.join(backupDir, fileName)

    if (
      !fileName ||
      path.dirname(path.relative(backupDir, filePath)) !== '.' ||
      !fs.existsSync(filePath) ||
      !fs.statSync(filePath).isFile()
    ) {
      response.status(404).json({ error: 'Backup file not found.' })
      return
    }

    response.download(filePath, fileName)
  } catch (error) {
    next(error)
  }
})

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

app.delete('/api/inventory/:id', (request, response, next) => {
  try {
    response.json({ data: deleteLocalInventoryDrug(request.params.id) })
  } catch (error) {
    next(error)
  }
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

app.get('/api/nhia/tariffs', (request, response) => {
  response.json({ data: listOfflineRecords('nhia_tariff_items', request.query) })
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

const priceOfflineNhisClaim = (claim) =>
  applyNhisCatalogPricing(claim, listOfflineRecords('nhis_drugs', { limit: 100000 }))

app.post('/api/nhis/claims', requireBranchUserSession, (request, response, next) => {
  try {
    const role = String(request.branchUser?.role || '').toLowerCase()
    const canManageClaims =
      ['admin', 'super_admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer'].includes(role) ||
      (role !== 'assistant' && request.branchUser?.canManageClaims === true)
    if (!canManageClaims) {
      response.status(403).json({ error: 'Only claims staff can create NHIS claims.' })
      return
    }
    const claim = saveOfflineRecord('nhis_claims', priceOfflineNhisClaim(request.body || {}))
    recordLocalAuditEvent({
      eventType: 'nhis_claim.sent_to_dispensary',
      actorUserId: request.branchUser?.userId || null,
      targetId: claim.id,
      detail: JSON.stringify({
        medicineCount: claim.nhis_claim_medicines?.length || 0,
        prescriptionAttached: Boolean(claim.prescription_file_path || claim.prescription_file_url),
      }),
      ipAddress: request.ip,
    })
    response.status(201).json({ data: claim })
  } catch (error) {
    next(error)
  }
})

app.put('/api/nhis/claims/:id', requireBranchUserSession, (request, response, next) => {
  try {
    const role = String(request.branchUser?.role || '').toLowerCase()
    const canManageClaims =
      ['admin', 'super_admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer'].includes(role) ||
      (role !== 'assistant' && request.branchUser?.canManageClaims === true)
    if (!canManageClaims) {
      response.status(403).json({ error: 'Only claims staff can edit NHIS claim details.' })
      return
    }
    const existing = getOfflineRecord('nhis_claims', request.params.id)
    if (!existing) {
      response.status(404).json({ error: 'NHIS claim not found.' })
      return
    }
    const expectedUpdatedAt = String(
      request.body?.expected_updated_at || request.body?.expectedUpdatedAt || ''
    ).trim()
    const currentUpdatedAt = String(existing.updated_at || existing.updatedAt || '').trim()
    if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
      response.status(409).json({
        error: 'This claim was changed by another staff member after you opened it. Reload the claim before saving so their work is not overwritten.',
        code: 'NHIS_CLAIM_CONFLICT',
      })
      return
    }
    const claimUpdates = { ...(request.body || {}) }
    delete claimUpdates.expected_updated_at
    delete claimUpdates.expectedUpdatedAt
    const claim = saveOfflineRecord('nhis_claims', priceOfflineNhisClaim({
        ...existing,
        ...claimUpdates,
        id: request.params.id,
      }))
    recordLocalAuditEvent({
      eventType: 'nhis_claim.intake_updated',
      actorUserId: request.branchUser?.userId || null,
      targetId: claim.id,
      detail: JSON.stringify({
        medicineCount: claim.nhis_claim_medicines?.length || 0,
        prescriptionAttached: Boolean(claim.prescription_file_path || claim.prescription_file_url),
        status: claim.status,
      }),
      ipAddress: request.ip,
    })
    response.json({ data: claim })
  } catch (error) {
    next(error)
  }
})

app.put('/api/nhis/claims/:id/medicines', requireBranchUserSession, (request, response, next) => {
  try {
    const role = String(request.branchUser?.role || '').toLowerCase()
    const canServeMedicines =
      ['admin', 'super_admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer'].includes(role) ||
      request.branchUser?.canManageClaims === true
    if (!canServeMedicines) {
      response.status(403).json({ error: 'You do not have permission to serve NHIS medicines.' })
      return
    }

    const existing = getOfflineRecord('nhis_claims', request.params.id)
    if (!existing) {
      response.status(404).json({ error: 'NHIS claim not found.' })
      return
    }
    const expectedUpdatedAt = String(
      request.body?.expected_updated_at || request.body?.expectedUpdatedAt || ''
    ).trim()
    const currentUpdatedAt = String(existing.updated_at || existing.updatedAt || '').trim()
    if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
      response.status(409).json({
        error: 'This claim was changed by another staff member after you opened it. Reload the claim before saving so their work is not overwritten.',
        code: 'NHIS_CLAIM_CONFLICT',
      })
      return
    }
    // Dispensary users may only add/remove medications within the edit window
    // (24h from creation, or a 12h supervisor re-open). Other roles are
    // unaffected. CC code, submission, and validation logic are not touched.
    if (role === 'assistant' && !isMcaEditWindowOpen(existing)) {
      response.status(403).json({
        error: 'The 24-hour edit window for this claim has closed. Ask an admin or claims officer to re-open it.',
      })
      return
    }
    const claim = saveOfflineRecord('nhis_claims', priceOfflineNhisClaim({
        ...existing,
        nhis_claim_medicines: Array.isArray(request.body?.nhis_claim_medicines)
          ? request.body.nhis_claim_medicines
          : [],
        status: request.body?.status || existing.status || 'returned_for_review',
        serving_status: request.body?.serving_status || existing.serving_status || null,
        updated_at: request.body?.updated_at || new Date().toISOString(),
        id: request.params.id,
      }))
    recordLocalAuditEvent({
      eventType: 'nhis_claim.dispensary_updated',
      actorUserId: request.branchUser?.userId || null,
      targetId: claim.id,
      detail: JSON.stringify({
        medicineCount: claim.nhis_claim_medicines?.length || 0,
        servingStatus: claim.serving_status,
        status: claim.status,
      }),
      ipAddress: request.ip,
    })
    response.json({ data: claim })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/nhis/claims/:id', requireBranchUserSession, (request, response, next) => {
  try {
    const role = String(request.branchUser?.role || '').trim().toLowerCase()
    const canDeleteNhisClaims =
      ['admin', 'super_admin'].includes(role) || request.branchUser?.canDeleteNhisClaims === true
    if (!canDeleteNhisClaims) {
      response.status(403).json({ error: 'You do not have permission to delete NHIS claims.' })
      return
    }
    response.json({ data: deleteOfflineRecord('nhis_claims', request.params.id) })
  } catch (error) {
    next(error)
  }
})

// Admin / claims officer re-opens the dispensary medication edit window for 12 hours.
// Requires a reason. Does not change CC code, submission, or validation logic.
app.post('/api/nhis/claims/:id/reopen-mca-edit', requireBranchUserSession, (request, response, next) => {
  try {
    const role = String(request.branchUser?.role || '').trim().toLowerCase()
    if (!canReopenMcaEditWindow(role)) {
      response.status(403).json({ error: 'Only an admin or claims officer can re-open the dispensary correction window.' })
      return
    }
    const reason = String(request.body?.reason || '').trim()
    if (!reason) {
      response.status(400).json({ error: 'A reason is required to re-open the dispensary correction window.' })
      return
    }
    const existing = getOfflineRecord('nhis_claims', request.params.id)
    if (!existing) {
      response.status(404).json({ error: 'NHIS claim not found.' })
      return
    }
    response.json({
      data: saveOfflineRecord('nhis_claims', {
        ...existing,
        ...buildMcaEditReopenFields({ reason, reopenedBy: request.branchUser?.id || request.branchUser?.userId || null }),
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

app.put('/api/nhia/settings', requireBranchUserSession, requireBranchAdminAccess, (request, response, next) => {
  try {
    response.json({ data: saveNhiaSettings(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/nhia-config', (_request, response) => {
  response.json({ data: getNhiaSettings() })
})

app.post('/api/nhia-config', requireBranchUserSession, requireBranchAdminAccess, (request, response, next) => {
  try {
    response.json({ data: saveNhiaSettings(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/nhia-config', requireBranchUserSession, requireBranchAdminAccess, (request, response, next) => {
  try {
    response.json({ data: saveNhiaSettings(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia-config/test', requireBranchUserSession, requireBranchAdminAccess, (_request, response) => {
  const health = getNhiaConfigurationHealth()
  response.json({
    data: {
      ok: health.ccGeneration.ready && health.claimItTransfer.ready,
      message: health.ccGeneration.ready && health.claimItTransfer.ready
        ? 'NHIA CC generation and CLAIM-it transfer are configured.'
        : 'NHIA configuration is reachable but incomplete.',
      health,
    },
  })
})

app.post('/api/nhia/cc-code', requireBranchUserSession, requireBranchClaimsAccess, async (request, response, next) => {
  try {
    response.json({ data: await generateNhiaCcCode(request.body || {}) })
  } catch (error) {
    next(error)
  }
})

// Member lookup: verifies NHIS membership and returns MobCCC + member details in one call.
app.post('/api/nhia/member-lookup', requireBranchUserSession, requireBranchClaimsAccess, async (request, response, next) => {
  try {
    const { memberNumber, cardType } = request.body || {}
    if (!memberNumber) {
      response.status(400).json({ error: 'memberNumber is required.' })
      return
    }
    response.json({ data: await lookupNhiaMember(memberNumber, { cardType }) })
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

app.post('/api/nhia/claims', requireBranchUserSession, requireBranchClaimsAccess, (request, response, next) => {
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

app.post('/api/nhia/claims/:id/ready', requireBranchUserSession, requireBranchClaimsAccess, (request, response, next) => {
  try {
    response.json({ data: markNhiaClaimReady(request.params.id) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia/claims/:id/submit', requireBranchUserSession, requireBranchClaimsAccess, async (request, response, next) => {
  try {
    response.json({ data: await submitNhiaClaim(request.params.id) })
  } catch (error) {
    next(error)
  }
})

// Unified NHIS claim route for both community pharmacies (medicines only) and hospital pharmacies (medicines + G-DRG services).
// Community pharmacy: organizationType omitted or 'pharmacy'; diagnosis optional, no service lines.
// Hospital pharmacy: organizationType 'hospital'; diagnosis required, services array included.
app.post('/api/nhis/pharmacy-claim', requireBranchUserSession, requireBranchClaimsAccess, async (request, response, next) => {
  try {
    const body = request.body || {}
    const {
      patientName, memberNumber, hin, schemeCode, gender, dateOfBirth,
      dispensingDate, referralFacility, diagnosis, medicines = [], services = [],
      claimPeriod, claimsOfficerName, organizationType,
    } = body

    const isHospital = (organizationType || '').toLowerCase() === 'hospital'

    if (!patientName || !memberNumber || (!medicines.length && !(isHospital && services.length))) {
      response.status(400).json({
        error: 'patientName, memberNumber, and at least one medicine or hospital service are required.',
      })
      return
    }
    if (isHospital && !diagnosis) {
      response.status(400).json({ error: 'diagnosis is required for hospital claims.' })
      return
    }

    const pricedLines = normalizePharmacyClaimLines({ medicines, services, isHospital })
    const totalAmount = pricedLines.totalAmount
    const serviceDate = normalizeNhiaServiceDate(dispensingDate) || toNhisCalendarDate()

    // Generate CC code unless one was supplied by the caller.
    let ccCode = body.ccCode || null
    if (!ccCode) {
      const ccResult = await generateNhiaCcCode({
        patientName,
        memberNumber,
        hin,
        diagnosis: isHospital ? diagnosis : undefined,
        serviceDate,
        totalAmount,
        organizationType: isHospital ? 'hospital' : 'pharmacy',
      })
      ccCode = ccResult.ccCode || null
    }

    // Persist the claim locally.
    // Field names must match what createNhiaClaim expects (camelCase).
    const claim = createNhiaClaim({
      patientName,
      memberNumber,
      memberNo: memberNumber,
      hin: hin || null,
      ccCode: ccCode || null,
      diagnosis: isHospital ? diagnosis : null,
      organizationType: isHospital ? 'hospital' : 'pharmacy',
      serviceDate,
      gender: gender || null,
      dateOfBirth: dateOfBirth || null,
      referralFacility: referralFacility || null,
      schemeCode: schemeCode || null,
      claimPeriod: claimPeriod || null,
      claimsOfficerName: claimsOfficerName || null,
      items: pricedLines.medicines.map((m) => ({
        drugId: m.drugId || m.drug_id || m.id || null,
        name: m.name,
        nhiaCode: m.nhiaCode || m.code || null,
        nhisCode: m.nhiaCode || m.code || null,
        quantity: Number(m.quantity),
        unitPrice: Number(m.unitPrice),
        price: Number(m.unitPrice),
        totalPrice: m.totalPrice,
        unit: m.unit || '',
        dosageForm: m.dosageForm || '',
        strength: m.strength || '',
        dispensaryDate: serviceDate,
      })),
      // Hospital service/G-DRG lines stored in payload for branch server persistence.
      services: pricedLines.services.map((s) => ({
        gdrg_code: s.gdrgCode || s.gdrg_code,
        description: s.description,
        age_band: s.ageBand || s.age_band || null,
        unit_price: s.unitPrice,
        quantity: s.quantity,
        total_amount: s.totalAmount,
        facility_group: s.facilityGroup || s.facility_group || null,
        catering_option: s.cateringOption || s.catering_option || null,
        mdc: s.mdc || null,
        service_date: serviceDate,
      })),
    })

    // Immediately submit to CLAIM-it.
    const submitted = await submitNhiaClaim(claim.id)
    response.status(201).json({ data: submitted })
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia/submit-pending', requireBranchUserSession, requireBranchClaimsAccess, async (request, response, next) => {
  try {
    response.json(await submitPendingNhiaClaims({ limit: request.body?.limit || 10 }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia/direct-submit', requireBranchUserSession, requireBranchClaimsAccess, async (request, response, next) => {
  try {
    response.json({
      data: await submitNhiaDirectPayload({
        payload: request.body?.payload,
        payloadContent: request.body?.payloadContent || '',
        contentType: request.body?.contentType || 'application/json',
        claimIds: request.body?.claimIds || [],
        action: request.body?.action || 'nhis.direct_submit',
      }),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia/repair-claim-ids', requireBranchUserSession, requireBranchClaimsAccess, (request, response, next) => {
  try {
    response.json({
      data: repairMissingNhiaClaimIds(request.body?.claimIds || []),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/nhia/batches', requireBranchUserSession, requireBranchClaimsAccess, (request, response, next) => {
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

app.get('/api/reports/bundle', (request, response, next) => {
  try {
    response.json({ data: getLocalReportBundle(request.query || {}) })
  } catch (error) {
    next(error)
  }
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

app.get('/api/pos-sessions/current', (request, response) => {
  response.json({
    data: getOpenLocalPosSession({ userId: request.branchUser.userId }),
  })
})

app.post('/api/pos-sessions/open', (request, response, next) => {
  try {
    response.status(201).json({
      data: openLocalPosSession({
        userId: request.branchUser.userId,
        organizationId: config.organizationId,
        branchId: config.branchId || request.body?.branchId,
        openingCash: request.body?.openingCash,
      }),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/pos-sessions/:id/close', (request, response, next) => {
  try {
    response.json({
      data: closeLocalPosSession({
        id: request.params.id,
        userId: request.branchUser.userId,
        countedCash: request.body?.countedCash,
        notes: request.body?.notes,
      }),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/sales', (request, response, next) => {
  try {
    const result = createLocalSale({
      ...(request.body || {}),
      soldBy: request.branchUser.userId,
      organizationId: config.organizationId,
      branchId: config.branchId || request.body?.branchId,
    })
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

app.post('/api/sync/repair', async (request, response, next) => {
  try {
    response.json(await repairFailedSync({ limit: request.body?.limit || 1000 }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/updates/status', (_request, response) => {
  response.json({ data: getUpdateStatus() })
})

app.post('/api/updates/check', async (_request, response, next) => {
  try {
    response.json({ data: await checkForUpdates() })
  } catch (error) {
    response.status(400).json({ error: error.message || 'Unable to check for updates.' })
  }
})

app.post('/api/updates/install', async (_request, response, next) => {
  try {
    response.status(202).json({ data: await installAvailableUpdate() })
  } catch (error) {
    response.status(400).json({ error: error.message || 'Unable to install the update.' })
  }
})

app.post('/api/sync/pull-inventory', async (request, response, next) => {
  try {
    response.json(await pullInventorySnapshot({ forceFull: request.body?.forceFull !== false }))
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

// ✅ SPA FALLBACK PATCH START
if (fs.existsSync(frontendIndex)) {
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next()
      return
    }

    response.setHeader('Cache-Control', 'no-store')
    response.sendFile(frontendIndex)
  })
}
// ✅ SPA FALLBACK PATCH END

app.use((error, _request, response, _next) => {
  console.error(error)
  const errorResponse = getBranchRequestErrorResponse(error)
  response.status(errorResponse.status).json(errorResponse.body)
})

const server = tlsRuntime.ready
  ? https.createServer({
      cert: tlsRuntime.credentials.cert,
      key: tlsRuntime.credentials.key,
    }, app)
  : app

server.listen(config.port, effectiveHost, () => {
  const protocol = tlsRuntime.ready ? 'https' : 'http'
  console.log(`HealthFlow local branch server listening on ${protocol}://${effectiveHost}:${config.port}`)
  console.log(`TLS status: ${tlsRuntime.status}${tlsRuntime.publicUrl ? ` (${tlsRuntime.publicUrl})` : ''}`)
  startSyncWorker()
  startUpdateScheduler()
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
  stopUpdateScheduler()

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
