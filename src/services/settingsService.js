import { getCurrentSupabaseUser, invokeSupabaseFunction, supabase } from '../lib/supabase'
import { assertRequiredText, normalizeText } from '../utils/validation'
import { STAFF_ROLE_VALUES } from '../utils/roles'
import { tryLogAuditEvent } from './auditService'

const STAFF_ADMIN_FUNCTION = 'staff-admin'

const invokeStaffAdmin = async (payload) => {
  const { data, error } = await invokeSupabaseFunction(STAFF_ADMIN_FUNCTION, {
    body: payload,
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }

  return data
}

const getCurrentOrganizationId = async () => {
  const user = await getCurrentSupabaseUser()

  if (!user?.id) {
    return null
  }

  const { data, error } = await supabase
    .from('users')
    .select('organization_id')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    throw error
  }

  return normalizeText(data?.organization_id) || null
}

export const getPharmacySettings = async () => {
  const organizationId = await getCurrentOrganizationId()
  let query = supabase
    .from('pharmacy_settings')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)

  if (organizationId) {
    query = query.eq('organization_id', organizationId)
  }

  let { data, error } = await query.maybeSingle()

  if (error) {
    throw error
  }

  if (data) {
    return data
  }

  return createSettings({
    organizationId,
    pharmacyName: 'HealthFlow Pharmacy',
  })
}

export const updatePharmacySettings = async (id, settings) => {
  const payload = {
    pharmacy_name: normalizeText(settings.pharmacyName),
    phone: normalizeText(settings.phone) || null,
    email: normalizeText(settings.email) || null,
    address: normalizeText(settings.address) || null,
    city: normalizeText(settings.city) || null,
    region: normalizeText(settings.region) || null,
    logo_url: normalizeText(settings.logoUrl ?? settings.logo_url) || null,
    slogan: normalizeText(settings.slogan) || null,
    license_number: normalizeText(settings.licenseNumber) || null,
    tax_rate: Number.parseFloat(settings.taxRate || 0),
    currency: normalizeText(settings.currency) || 'GHS',
    default_markup_percent: Number.parseFloat(settings.defaultMarkupPercent || 0),
    low_stock_threshold: Number.parseFloat(settings.lowStockThreshold || 10),
    expiry_alert_days: Number.parseInt(settings.expiryAlertDays || 30, 10),
    receipt_footer: normalizeText(settings.receiptFooter) || null,
    updated_at: new Date().toISOString(),
  }

  const organizationId = await getCurrentOrganizationId()
  if (organizationId) {
    payload.organization_id = organizationId
  }

  let query = supabase
    .from('pharmacy_settings')
    .update(payload)
    .select()

  if (id) {
    query = query.eq('id', id)
  } else if (organizationId) {
    query = query.eq('organization_id', organizationId)
  } else {
    throw new Error('Unable to determine which pharmacy settings to update.')
  }

  const { data, error } = await query.single()

  if (error) {
    throw error
  }

  await tryLogAuditEvent({
    eventType: 'settings.updated',
    entityType: 'pharmacy_settings',
    entityId: data.id,
    action: 'update',
    details: {
      pharmacy_name: data.pharmacy_name,
      currency: data.currency,
      default_markup_percent: data.default_markup_percent,
      low_stock_threshold: data.low_stock_threshold,
      expiry_alert_days: data.expiry_alert_days,
    },
  })

  return data
}

export const createSettings = async (settings) => {
  const payload = {
    pharmacy_name:
      normalizeText(settings.pharmacy_name ?? settings.pharmacyName) || 'HealthFlow Pharmacy',
    phone: normalizeText(settings.phone) || null,
    email: normalizeText(settings.email) || null,
    address: normalizeText(settings.address) || null,
    city: normalizeText(settings.city) || null,
    region: normalizeText(settings.region) || null,
    logo_url: normalizeText(settings.logo_url ?? settings.logoUrl) || null,
    slogan: normalizeText(settings.slogan) || null,
    license_number: normalizeText(settings.license_number ?? settings.licenseNumber) || null,
    tax_rate: Number.parseFloat(settings.tax_rate ?? settings.taxRate ?? 0),
    currency: normalizeText(settings.currency) || 'GHS',
    default_markup_percent: Number.parseFloat(
      settings.default_markup_percent ?? settings.defaultMarkupPercent ?? 0
    ),
    low_stock_threshold: Number.parseFloat(
      settings.low_stock_threshold ?? settings.lowStockThreshold ?? 10
    ),
    expiry_alert_days: Number.parseInt(
      settings.expiry_alert_days ?? settings.expiryAlertDays ?? 30,
      10
    ),
    receipt_footer: normalizeText(settings.receipt_footer ?? settings.receiptFooter) || null,
  }

  const organizationId =
    normalizeText(settings.organization_id ?? settings.organizationId) || null

  if (organizationId) {
    payload.organization_id = organizationId
  }

  const { data, error } = await supabase
    .from('pharmacy_settings')
    .insert([payload])
    .select()
    .single()

  if (error) {
    throw error
  }

  await tryLogAuditEvent({
    eventType: 'settings.created',
    entityType: 'pharmacy_settings',
    entityId: data.id,
    action: 'create',
    details: {
      pharmacy_name: data.pharmacy_name,
      currency: data.currency,
      default_markup_percent: data.default_markup_percent,
      low_stock_threshold: data.low_stock_threshold,
      expiry_alert_days: data.expiry_alert_days,
    },
  })

  return data
}

export const getUsers = async () => {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, role, can_refund, is_active, branch_id, created_at, branches (id, name, code)')
    .order('created_at', { ascending: false })

  if (error) {
    throw error
  }

  return data
}

export const createStaffUser = async (staff) => {
  const fullName = assertRequiredText(staff.fullName, 'Full name')
  const email = assertRequiredText(staff.email, 'Email').toLowerCase()
  const temporaryPassword = assertRequiredText(staff.temporaryPassword, 'Temporary password')
  const role = normalizeText(staff.role || 'assistant').toLowerCase()
  const phone = normalizeText(staff.phone) || null

  if (!STAFF_ROLE_VALUES.includes(role)) {
    throw new Error('Select a valid staff role.')
  }

  if (temporaryPassword.length < 8) {
    throw new Error('Temporary password must be at least 8 characters.')
  }

  const response = await invokeStaffAdmin({
    action: 'upsert_staff_user',
    email,
    fullName,
    phone,
    role,
    canRefund: Boolean(staff.canRefund),
    canManageInventory: Boolean(staff.canManageInventory),
    canViewReports: Boolean(staff.canViewReports),
    canManageClaims: Boolean(staff.canManageClaims),
    password: temporaryPassword,
  })

  return response.user
}

export const updateUserStatus = async (id, isActive) => {
  const userId = assertRequiredText(id, 'User id')
  const response = await invokeStaffAdmin({
    action: 'set_staff_status',
    userId,
    isActive: Boolean(isActive),
  })

  return response.user
}

export const updateUserRefundPermission = async (id, canRefund) => {
  const userId = assertRequiredText(id, 'User id')
  const response = await invokeStaffAdmin({
    action: 'set_refund_permission',
    userId,
    canRefund: Boolean(canRefund),
  })

  return response.user
}

export const updateUserBranch = async (userId, branchId) => {
  const { error } = await supabase
    .from('users')
    .update({ branch_id: branchId || null })
    .eq('id', userId)

  if (error) throw error
}
