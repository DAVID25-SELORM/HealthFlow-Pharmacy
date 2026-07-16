export const ROLE_LABELS = {
  admin: 'Administrator',
  pharmacist: 'Pharmacist',
  assistant: 'Dispensary Assistant',
  technician: 'Pharmacy Technician',
  cashier: 'Cashier',
  inventory_officer: 'Inventory Officer',
  accounts_officer: 'Accounts Officer',
  nurse: 'Nurse',
  doctor: 'Doctor',
  records_officer: 'Records Officer',
  other: 'Other / Custom Staff',
  branch_manager: 'Store / Branch Manager',
  procurement: 'Warehouse / Procurement Officer',
  claims_officer: 'Claims Officer',
  billing: 'Billing / Insurance Officer',
  delivery: 'Delivery Staff',
  super_admin: 'Super Admin',
}

export const getRoleLabel = (role) =>
  ROLE_LABELS[String(role || '').toLowerCase()] ??
  String(role || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
