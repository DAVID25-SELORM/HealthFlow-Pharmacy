export const ROLE_OPTIONS = [
  { value: 'admin', label: 'Administrator' },
  { value: 'pharmacist', label: 'Pharmacist' },
  { value: 'technician', label: 'Pharmacy Technician' },
  { value: 'assistant', label: 'Medicine Counter Assistant' },
  { value: 'cashier', label: 'Cashier' },
  { value: 'inventory_officer', label: 'Inventory Officer' },
  { value: 'claims_officer', label: 'Claims Officer' },
  { value: 'accounts_officer', label: 'Accounts Officer' },
  { value: 'nurse', label: 'Nurse' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'records_officer', label: 'Records Officer' },
  { value: 'other', label: 'Other / Custom Staff' },
  { value: 'branch_manager', label: 'Store / Branch Manager' },
  { value: 'procurement', label: 'Warehouse / Procurement Officer' },
  { value: 'billing', label: 'Billing / Insurance Officer' },
  { value: 'delivery', label: 'Delivery Staff' },
]

export const STAFF_ROLE_VALUES = ROLE_OPTIONS.map((role) => role.value)

export const DASHBOARD_ROLES = [...STAFF_ROLE_VALUES, 'super_admin']
export const SALES_ROLES = ['admin', 'pharmacist', 'assistant', 'cashier', 'technician', 'branch_manager']
export const PATIENT_ROLES = [
  'admin',
  'pharmacist',
  'assistant',
  'technician',
  'branch_manager',
  'billing',
  'claims_officer',
  'nurse',
  'doctor',
  'records_officer',
]
export const INVENTORY_ROLES = [
  'admin',
  'pharmacist',
  'technician',
  'procurement',
  'inventory_officer',
  'branch_manager',
]
export const CLAIMS_ROLES = [
  'admin',
  'pharmacist',
  'billing',
  'claims_officer',
  'records_officer',
]
export const REPORT_ROLES = [
  'super_admin',
  'admin',
  'pharmacist',
  'cashier',
  'billing',
  'branch_manager',
  'procurement',
  'accountant',
  'accounts_officer',
  'inventory_officer',
  'claims_officer',
]
export const ACCOUNTING_ROLES = ['admin', 'accounts_officer']
export const SETTINGS_ROLES = ['admin']
export const ACTIVITY_LOG_ROLES = ['admin', 'branch_manager', 'super_admin']
export const OFFLINE_SYNC_ROLES = ['admin', 'branch_manager', 'super_admin']
export const PURCHASES_ROLES = [
  'admin',
  'pharmacist',
  'procurement',
  'inventory_officer',
  'branch_manager',
]
export const NHIS_ROLES = ['admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer']
export const EPHARMACY_ROLES = [
  'admin',
  'pharmacist',
  'procurement',
  'inventory_officer',
  'branch_manager',
]
export const PATIENT_CARE_ROLES = [
  'admin',
  'pharmacist',
  'assistant',
  'technician',
  'branch_manager',
  'billing',
  'claims_officer',
  'nurse',
  'doctor',
  'records_officer',
]

export const hasRole = (role, roles = []) => {
  const normalizedRole = String(role || '').toLowerCase()
  const normalizedRoles = roles.map((item) => String(item || '').toLowerCase())

  if (normalizedRole === 'admin' && !normalizedRoles.includes('super_admin')) {
    return true
  }

  return normalizedRoles.includes(normalizedRole)
}

export const normalizeAssignedRoles = (assignedRoles, primaryRole = 'assistant') => {
  const values = Array.isArray(assignedRoles) ? assignedRoles : []
  const normalizedPrimaryRole = String(primaryRole || 'assistant').trim().toLowerCase()
  const validRoles = new Set([...STAFF_ROLE_VALUES, 'super_admin'])

  return [...new Set([normalizedPrimaryRole, ...values.map((role) => String(role || '').trim().toLowerCase())])]
    .filter((role) => validRoles.has(role))
}
