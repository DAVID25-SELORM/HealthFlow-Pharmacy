export const ROLE_OPTIONS = [
  { value: 'assistant', label: 'Medicine Counter Assistant' },
  { value: 'cashier', label: 'Cashier' },
  { value: 'technician', label: 'Pharmacy Technician' },
  { value: 'pharmacist', label: 'Pharmacist' },
  { value: 'branch_manager', label: 'Store / Branch Manager' },
  { value: 'procurement', label: 'Warehouse / Procurement Officer' },
  { value: 'claims_officer', label: 'Claims Officer' },
  { value: 'billing', label: 'Billing / Insurance Officer' },
  { value: 'delivery', label: 'Delivery Staff' },
  { value: 'admin', label: 'Admin' },
]

export const STAFF_ROLE_VALUES = ROLE_OPTIONS.map((role) => role.value)

export const DASHBOARD_ROLES = [...STAFF_ROLE_VALUES, 'super_admin']
export const SALES_ROLES = ['admin', 'pharmacist', 'assistant', 'cashier', 'technician', 'branch_manager']
export const PATIENT_ROLES = ['admin', 'pharmacist', 'assistant', 'technician', 'branch_manager', 'billing']
export const INVENTORY_ROLES = ['admin', 'pharmacist', 'technician', 'procurement', 'branch_manager']
export const CLAIMS_ROLES = ['admin', 'pharmacist', 'billing', 'claims_officer']
export const REPORT_ROLES = ['admin', 'pharmacist', 'branch_manager']
export const ACCOUNTING_ROLES = ['admin']
export const SETTINGS_ROLES = ['admin']
export const ACTIVITY_LOG_ROLES = ['admin', 'branch_manager', 'super_admin']
export const OFFLINE_SYNC_ROLES = ['admin', 'branch_manager', 'super_admin']
export const PURCHASES_ROLES = ['admin', 'pharmacist', 'procurement', 'branch_manager']
export const NHIS_ROLES = ['admin', 'pharmacist', 'billing', 'claims_officer']
export const EPHARMACY_ROLES = ['admin', 'pharmacist', 'procurement', 'branch_manager']

export const hasRole = (role, roles = []) => {
  const normalizedRole = String(role || '').toLowerCase()
  const normalizedRoles = roles.map((item) => String(item || '').toLowerCase())

  if (normalizedRole === 'admin' && !normalizedRoles.includes('super_admin')) {
    return true
  }

  return normalizedRoles.includes(normalizedRole)
}
