export const ROLE_LABELS = {
  admin: 'Admin',
  pharmacist: 'Pharmacist',
  assistant: 'Medicine Counter Assistant',
  super_admin: 'Super Admin',
}

export const getRoleLabel = (role) =>
  ROLE_LABELS[String(role || '').toLowerCase()] ??
  String(role || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
