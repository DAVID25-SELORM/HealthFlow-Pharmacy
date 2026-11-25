// Who may use which route of the offline server. The role lists mirror src/utils/roles.js (what the app lets each
// role open); localAuthorizationRoutes.test.js fails if they drift apart. A permission switched on for one person
// (canProcessSales and so on) adds to what their role allows.
export const ROLE_ACCESS = {
  sales: new Set(['admin', 'pharmacist', 'assistant', 'cashier', 'technician', 'branch_manager']),
  patients: new Set(['admin', 'pharmacist', 'assistant', 'technician', 'branch_manager', 'billing', 'claims_officer', 'nurse', 'doctor', 'records_officer']),
  inventory: new Set(['admin', 'pharmacist', 'technician', 'procurement', 'inventory_officer', 'branch_manager']),
  purchases: new Set(['admin', 'super_admin', 'pharmacist', 'procurement', 'inventory_officer', 'branch_manager']),
  claims: new Set(['admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer']),
  reports: new Set(['admin', 'super_admin', 'pharmacist', 'cashier', 'billing', 'branch_manager', 'procurement', 'accountant', 'accounts_officer', 'inventory_officer', 'claims_officer']),
  accounting: new Set(['admin', 'accounts_officer']),
  operations: new Set(['admin', 'branch_manager', 'super_admin']),
  admin: new Set(['admin', 'super_admin']),
}

const roleOf = (request) => String(request.branchUser?.role || '').trim().toLowerCase()

const hasRole = (request, roles) => roles.has(roleOf(request))

const CAN = {
  sales: (request) => hasRole(request, ROLE_ACCESS.sales) || Boolean(request.branchUser?.canProcessSales),
  patients: (request) => hasRole(request, ROLE_ACCESS.patients) || Boolean(request.branchUser?.canManagePatients),
  claims: (request) =>
    hasRole(request, ROLE_ACCESS.claims) ||
    (roleOf(request) !== 'assistant' && Boolean(request.branchUser?.canManageClaims)),
  purchases: (request) =>
    hasRole(request, ROLE_ACCESS.purchases) || Boolean(request.branchUser?.canManagePurchases),
  stockKeeping: (request) =>
    hasRole(request, ROLE_ACCESS.inventory) ||
    Boolean(request.branchUser?.canAdjustStock || request.branchUser?.canManageInventory),
  reports: (request) =>
    hasRole(request, ROLE_ACCESS.reports) ||
    hasRole(request, ROLE_ACCESS.accounting) ||
    Boolean(request.branchUser?.canViewReports || request.branchUser?.canManageAccounting),
  operations: (request) => hasRole(request, ROLE_ACCESS.operations),
  admin: (request) => hasRole(request, ROLE_ACCESS.admin),
}

const anyOf = (...checks) => (request) => checks.some((check) => check(request))

const rejectRole = (response) =>
  response.status(403).json({ error: 'Your current staff role does not permit this local operation.' })

// The full path. Under app.use('/api', ...) Express takes '/api' out of request.path and puts it in request.baseUrl;
// reading request.path alone made every rule below miss. Lower case, because Express matches routes in any case.
const getFullPath = (request) =>
  `${request.baseUrl || ''}${request.path || ''}`.toLowerCase().replace(/\/+$/, '')

const isUnder = (pathName, ...prefixes) =>
  prefixes.some((prefix) => pathName === prefix || pathName.startsWith(`${prefix}/`))

// Settings and price lists the till needs for an NHIS sale. No patient records and no saved credentials.
const TILL_REFERENCE_READS = new Set([
  '/api/nhis/drugs',
  '/api/nhia/tariffs',
  '/api/nhia-config',
  '/api/nhia/settings',
])

const getRule = (pathName, method) => {
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method)

  // The "an update is waiting" notice is for all signed-in staff.
  if (!isWrite && pathName === '/api/updates/notice') return () => true
  if (isUnder(pathName, '/api/database', '/api/updates')) return CAN.admin

  // The till shows how many records are still waiting to be sent.
  if (!isWrite && pathName === '/api/sync/status') return anyOf(CAN.operations, CAN.sales)
  if (isUnder(pathName, '/api/sync', '/api/offline/readiness', '/api/preload')) return CAN.operations

  if (isUnder(pathName, '/api/reports')) return CAN.reports
  if (isUnder(pathName, '/api/purchases', '/api/suppliers')) return CAN.purchases

  if (isUnder(pathName, '/api/inventory')) {
    if (isWrite) return CAN.stockKeeping
    // Looking at stock: also the till, claims screens, purchasing and the offline setup check.
    return anyOf(CAN.stockKeeping, CAN.sales, CAN.claims, CAN.purchases, CAN.operations)
  }

  if (isUnder(pathName, '/api/patients')) {
    // The till and claims screens look a patient up; only patient staff add or change one.
    return isWrite ? CAN.patients : anyOf(CAN.patients, CAN.sales, CAN.claims)
  }

  // A sale at the till first looks through existing NHIS claims for a repeated CC code, then saves a claim for the
  // claims officer to review. So till staff may read the list and add a claim, but not change or delete one.
  // A patient's history also shows their NHIS visits.
  if (pathName === '/api/nhis/claims' && !isWrite) return anyOf(CAN.claims, CAN.sales, CAN.patients)
  if (method === 'POST' && (pathName === '/api/nhis/claims' || pathName === '/api/claims')) {
    return anyOf(CAN.claims, CAN.sales)
  }
  if (!isWrite && TILL_REFERENCE_READS.has(pathName)) return anyOf(CAN.claims, CAN.sales)

  // Changing NHIA settings also needs the administrator check that those routes carry themselves.
  if (isUnder(pathName, '/api/claims', '/api/nhis', '/api/nhia', '/api/nhia-config')) return CAN.claims

  // The offline setup check reads recent sales.
  if (!isWrite && pathName === '/api/sales/recent') return anyOf(CAN.sales, CAN.operations)
  if (isUnder(pathName, '/api/sales', '/api/pos', '/api/pos-sessions', '/api/payments')) return CAN.sales

  return null
}

export const authorizeLocalOperationalRoute = (request, response, next) => {
  const pathName = getFullPath(request)
  const method = String(request.method || 'GET').toUpperCase()
  const rule = getRule(pathName, method)

  // A route with no rule is closed, so a new route cannot be left open by accident.
  if (!rule || !rule(request)) return rejectRole(response)

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && isUnder(pathName, '/api/purchases', '/api/suppliers')) {
    const nextStatus = String(request.body?.status || '').trim().toLowerCase()
    if (['approved', 'completed', 'received'].includes(nextStatus)) {
      if (!['admin', 'pharmacist', 'branch_manager'].includes(roleOf(request)) && !request.branchUser?.canApprovePurchases) {
        return response.status(403).json({ error: 'Purchase approval permission is required.' })
      }
    }
  }

  return next()
}
