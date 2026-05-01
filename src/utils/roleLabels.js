export const ROLE_LABELS = {
  admin: 'Admin',
  pharmacist: 'Pharmacist',
  assistant: 'Medicine Counter Assistant',
  technician: 'Pharmacy Technician',
  cashier: 'Cashier',
  branch_manager: 'Store / Branch Manager',
  procurement: 'Warehouse / Procurement Officer',
  billing: 'Billing / Insurance Officer',
  delivery: 'Delivery Staff',
  super_admin: 'Super Admin',
}

export const getRoleLabel = (role) =>
  ROLE_LABELS[String(role || '').toLowerCase()] ??
  String(role || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
