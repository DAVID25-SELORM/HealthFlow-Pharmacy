import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROLE_ACCESS, authorizeLocalOperationalRoute } from './localAuthorization.js'
import * as appRoles from '../../src/utils/roles.js'

// The rules once matched nothing: they were tested with hand-written paths such as '/api/database', but Express
// removes '/api' under app.use('/api', ...). So these tests go through a real Express server mounted the same way,
// with the route list read from server.js itself.
const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'local-branch-server/src/server.js'), 'utf8')
const guardedSource = serverSource.slice(serverSource.indexOf("app.use('/api', requireBranchUserSession"))
const ROUTES = [...guardedSource.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']+)'/g)]
  .map((match) => ({ method: match[1].toUpperCase(), route: match[2] }))

const OPEN_TO_ALL_STAFF = ['GET /api/updates/notice']

let server
let baseUrl

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', (request, _response, next) => {
    request.branchUser = JSON.parse(request.get('x-test-user'))
    next()
  }, authorizeLocalOperationalRoute)
  for (const { method, route } of ROUTES) {
    app[method.toLowerCase()](route, (_request, response) => response.json({ reached: true }))
  }
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

const statusFor = async (user, request, body) => {
  const [method, route] = request.split(' ')
  const response = await fetch(`${baseUrl}${route.replace(/:[A-Za-z]+/g, 'x1')}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': JSON.stringify(typeof user === 'string' ? { role: user } : user) },
    ...(['GET', 'DELETE'].includes(method) ? {} : { body: JSON.stringify(body || {}) }),
  })
  await response.arrayBuffer()
  return response.status
}

const expectAllowed = async (user, requests) => {
  for (const request of requests) {
    expect([request, await statusFor(user, request)]).toEqual([request, 200])
  }
}

const expectRefused = async (user, requests) => {
  for (const request of requests) {
    expect([request, await statusFor(user, request)]).toEqual([request, 403])
  }
}

describe('every route behind the staff sign-in', () => {
  it('is found in server.js', () => {
    expect(ROUTES.length).toBeGreaterThan(60)
    expect(ROUTES).toContainEqual({ method: 'GET', route: '/api/database/backups/:fileName/download' })
  })

  it('refuses staff whose role gives no access, except the update notice', async () => {
    for (const role of ['delivery', 'other', '']) {
      for (const { method, route } of ROUTES) {
        const request = `${method} ${route}`
        expect([role, request, await statusFor(role, request)])
          .toEqual([role, request, OPEN_TO_ALL_STAFF.includes(request) ? 200 : 403])
      }
    }
  }, 60000) // Over two hundred real requests: too many for the default limit on a busy computer.

  it('has a rule, so an administrator reaches every one', async () => {
    await expectAllowed('admin', ROUTES.map(({ method, route }) => `${method} ${route}`))
  })

  it('is closed when no rule knows it', async () => {
    expect(await statusFor('admin', 'GET /api/something-new')).toBe(403)
  })
})

describe('what was open to any signed-in staff member', () => {
  const BACKUPS = [
    'POST /api/database/backup',
    'GET /api/database/backups/anything.sqlite/download',
    'GET /api/database/status',
  ]

  it('database backups are for administrators only', async () => {
    for (const role of ['cashier', 'assistant', 'pharmacist', 'branch_manager', 'billing', 'nurse', 'accounts_officer']) {
      await expectRefused(role, BACKUPS)
    }
    await expectAllowed('admin', BACKUPS)
    await expectAllowed('super_admin', BACKUPS)
  })

  it('writing the path in capitals does not get round a rule', async () => {
    await expectRefused('cashier', [
      'POST /api/Database/backup',
      'GET /api/DATABASE/backups/anything.sqlite/download',
      'POST /API/updates/install',
      'POST /api/Sync/run',
    ])
  })

  it('a trailing slash does not get round a rule', async () => {
    await expectRefused('cashier', ['POST /api/database/backup/', 'GET /api/preload/'])
  })

  it('the all-in-one download and sync actions are for operations staff', async () => {
    for (const role of ['cashier', 'pharmacist', 'assistant']) {
      await expectRefused(role, ['GET /api/preload', 'POST /api/sync/run', 'POST /api/sync/reconnect', 'POST /api/sync/pull-inventory'])
    }
    await expectAllowed('branch_manager', ['GET /api/preload', 'POST /api/sync/run', 'GET /api/offline/readiness'])
  })
})

// Each list is what that person's screens ask the offline server for.
describe('daily work still goes through', () => {
  const TILL = [
    'GET /api/pos/bootstrap', 'GET /api/pos-sessions/current', 'POST /api/pos-sessions/open',
    'POST /api/pos-sessions/:id/close', 'GET /api/inventory', 'GET /api/inventory/search', 'GET /api/patients',
    'POST /api/sales', 'GET /api/sales/recent', 'GET /api/sales/:id', 'GET /api/sync/status',
    'POST /api/payments/initiate', 'GET /api/payments/status/:reference',
    // NHIS and insurance sales
    'GET /api/nhia-config', 'GET /api/nhis/drugs', 'GET /api/nhia/tariffs', 'GET /api/nhis/claims',
    'POST /api/nhis/claims', 'POST /api/claims',
  ]

  it.each(['cashier', 'technician', 'branch_manager', 'assistant', 'pharmacist'])('%s at the till', async (role) => {
    await expectAllowed(role, TILL)
  })

  it('a cashier cannot change or delete claims, patients or stock', async () => {
    await expectRefused('cashier', [
      'PUT /api/nhis/claims/:id', 'DELETE /api/nhis/claims/:id', 'PUT /api/nhis/claims/:id/medicines',
      'GET /api/claims', 'PUT /api/claims/:id', 'POST /api/nhis/drugs', 'POST /api/patients', 'PUT /api/patients/:id',
      'DELETE /api/inventory/:id', 'POST /api/inventory/import', 'POST /api/purchases', 'PUT /api/nhia/settings',
      'POST /api/nhia-config', 'POST /api/nhia/direct-submit',
    ])
  })

  it('NHIS dispensary assistant', async () => {
    await expectAllowed('assistant', [
      'GET /api/patients', 'POST /api/patients', 'GET /api/nhis/claims', 'POST /api/nhis/claims',
      'PUT /api/nhis/claims/:id', 'PUT /api/nhis/claims/:id/medicines', 'GET /api/nhis/prescribers',
      'POST /api/nhis/prescribing-facilities', 'GET /api/nhis/drugs', 'GET /api/inventory',
    ])
  })

  it.each(['claims_officer', 'billing', 'records_officer'])('%s on the claims screens', async (role) => {
    await expectAllowed(role, [
      'GET /api/claims', 'POST /api/claims', 'PUT /api/claims/:id', 'GET /api/patients', 'POST /api/patients',
      'GET /api/nhis/claims', 'PUT /api/nhis/claims/:id', 'POST /api/nhis/pharmacy-claim', 'GET /api/inventory',
      'GET /api/nhia/summary', 'GET /api/nhia/claims',
    ])
  })

  it.each(['nurse', 'doctor'])('%s looking after patients', async (role) => {
    await expectAllowed(role, ['GET /api/patients', 'POST /api/patients', 'PUT /api/patients/:id', 'GET /api/nhis/claims'])
    await expectRefused(role, ['POST /api/nhis/claims', 'GET /api/claims', 'POST /api/sales', 'GET /api/inventory'])
  })

  it.each(['procurement', 'inventory_officer'])('%s looking after stock', async (role) => {
    await expectAllowed(role, [
      'GET /api/inventory', 'POST /api/inventory/import', 'DELETE /api/inventory/:id', 'GET /api/suppliers',
      'POST /api/suppliers', 'GET /api/purchases', 'POST /api/purchases', 'GET /api/reports/bundle',
    ])
    await expectRefused(role, ['GET /api/patients', 'GET /api/nhis/claims', 'POST /api/sales'])
  })

  it.each(['accounts_officer', 'accountant'])('%s reading reports', async (role) => {
    await expectAllowed(role, ['GET /api/reports/bundle'])
    await expectRefused(role, ['GET /api/patients', 'GET /api/nhis/claims', 'GET /api/inventory'])
  })

  it('offline setup check by a platform administrator', async () => {
    await expectAllowed('super_admin', [
      'GET /api/sync/status', 'POST /api/sync/run', 'GET /api/offline/readiness', 'GET /api/inventory',
      'GET /api/sales/recent', 'GET /api/purchases', 'GET /api/reports/bundle',
    ])
  })

  it('a permission given to one person adds to their role', async () => {
    await expectAllowed({ role: 'other', canProcessSales: true }, ['POST /api/sales', 'GET /api/patients'])
    await expectAllowed({ role: 'cashier', canManageClaims: true }, ['PUT /api/nhis/claims/:id', 'GET /api/claims'])
    await expectAllowed({ role: 'other', canManageInventory: true }, ['DELETE /api/inventory/:id'])
    await expectRefused({ role: 'assistant', canManageClaims: false }, ['GET /api/database/status'])
  })

  it('still needs approval permission to mark a purchase received', async () => {
    const user = { role: 'procurement' }
    expect(await statusFor(user, 'PUT /api/purchases/:id', { status: 'received' })).toBe(403)
    expect(await statusFor({ ...user, canApprovePurchases: true }, 'PUT /api/purchases/:id', { status: 'received' })).toBe(200)
    expect(await statusFor('Procurement', 'PUT /api/Purchases/:id', { status: 'completed' })).toBe(403)
  })
})

describe('the server role lists', () => {
  const sorted = (values) => [...values].sort()
  const withoutPlatform = (values) => sorted(values).filter((role) => role !== 'super_admin')

  it('match the lists the app uses to open screens', () => {
    expect(withoutPlatform(ROLE_ACCESS.sales)).toEqual(withoutPlatform(appRoles.SALES_ROLES))
    expect(withoutPlatform(ROLE_ACCESS.patients)).toEqual(withoutPlatform(appRoles.PATIENT_ROLES))
    expect(withoutPlatform(ROLE_ACCESS.inventory)).toEqual(withoutPlatform(appRoles.INVENTORY_ROLES))
    expect(withoutPlatform(ROLE_ACCESS.purchases)).toEqual(withoutPlatform(appRoles.PURCHASES_ROLES))
    expect(withoutPlatform(ROLE_ACCESS.claims)).toEqual(withoutPlatform(appRoles.NHIS_ROLES))
    expect(sorted(ROLE_ACCESS.reports)).toEqual(sorted(appRoles.REPORT_ROLES))
    expect(sorted(ROLE_ACCESS.accounting)).toEqual(sorted(appRoles.ACCOUNTING_ROLES))
    expect(sorted(ROLE_ACCESS.operations)).toEqual(sorted(appRoles.OFFLINE_SYNC_ROLES))
  })

  it('include every role that can open the claims screen', () => {
    for (const role of appRoles.CLAIMS_ROLES) expect(ROLE_ACCESS.claims.has(role)).toBe(true)
  })
})
