const ROLE_ACCESS = {
  sales: new Set(['admin', 'pharmacist', 'assistant', 'cashier', 'technician', 'branch_manager']),
  patients: new Set(['admin', 'pharmacist', 'assistant', 'technician', 'branch_manager', 'billing', 'claims_officer', 'nurse', 'doctor', 'records_officer']),
  inventory: new Set(['admin', 'pharmacist', 'technician', 'procurement', 'inventory_officer', 'branch_manager']),
  purchases: new Set(['admin', 'pharmacist', 'procurement', 'inventory_officer', 'branch_manager']),
  claims: new Set(['admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer']),
  reports: new Set(['admin', 'pharmacist', 'cashier', 'billing', 'branch_manager', 'procurement', 'accountant', 'accounts_officer', 'inventory_officer', 'claims_officer']),
  operations: new Set(['admin', 'branch_manager', 'super_admin']),
  admin: new Set(['admin', 'super_admin']),
}

const hasRole = (request, roles) =>
  roles.has(String(request.branchUser?.role || '').trim().toLowerCase())

const rejectRole = (response) =>
  response.status(403).json({ error: 'Your current staff role does not permit this local operation.' })

export const authorizeLocalOperationalRoute = (request, response, next) => {
  const pathName = request.path
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)

  if (pathName.startsWith('/api/database') || pathName.startsWith('/api/updates')) {
    return hasRole(request, ROLE_ACCESS.admin) ? next() : rejectRole(response)
  }
  if (
    pathName.startsWith('/api/sync') ||
    pathName === '/api/offline/readiness' ||
    pathName === '/api/preload'
  ) {
    return hasRole(request, ROLE_ACCESS.operations) ? next() : rejectRole(response)
  }
  if (pathName.startsWith('/api/reports')) {
    return hasRole(request, ROLE_ACCESS.reports) || request.branchUser?.canViewReports
      ? next()
      : rejectRole(response)
  }
  if (pathName.startsWith('/api/purchases') || pathName.startsWith('/api/suppliers')) {
    if (!hasRole(request, ROLE_ACCESS.purchases) && !request.branchUser?.canManagePurchases) {
      return rejectRole(response)
    }
    const nextStatus = String(request.body?.status || '').trim().toLowerCase()
    if (isWrite && ['approved', 'completed', 'received'].includes(nextStatus)) {
      const role = String(request.branchUser?.role || '').trim().toLowerCase()
      if (!['admin', 'pharmacist', 'branch_manager'].includes(role) && !request.branchUser?.canApprovePurchases) {
        return response.status(403).json({ error: 'Purchase approval permission is required.' })
      }
    }
    return next()
  }
  if (pathName.startsWith('/api/inventory')) {
    const roles = isWrite
      ? ROLE_ACCESS.inventory
      : new Set([...ROLE_ACCESS.inventory, ...ROLE_ACCESS.sales])
    const privilege = isWrite
      ? request.branchUser?.canAdjustStock || request.branchUser?.canManageInventory
      : request.branchUser?.canManageInventory || request.branchUser?.canProcessSales
    return hasRole(request, roles) || privilege ? next() : rejectRole(response)
  }
  if (pathName.startsWith('/api/patients')) {
    return hasRole(request, ROLE_ACCESS.patients) || request.branchUser?.canManagePatients
      ? next()
      : rejectRole(response)
  }
  if (
    pathName.startsWith('/api/claims') ||
    pathName.startsWith('/api/nhis') ||
    pathName.startsWith('/api/nhia')
  ) {
    const role = String(request.branchUser?.role || '').trim().toLowerCase()
    return hasRole(request, ROLE_ACCESS.claims) ||
      (role !== 'assistant' && request.branchUser?.canManageClaims)
      ? next()
      : rejectRole(response)
  }
  if (
    pathName.startsWith('/api/sales') ||
    pathName.startsWith('/api/pos') ||
    pathName.startsWith('/api/payments')
  ) {
    return hasRole(request, ROLE_ACCESS.sales) || request.branchUser?.canProcessSales
      ? next()
      : rejectRole(response)
  }
  return next()
}
