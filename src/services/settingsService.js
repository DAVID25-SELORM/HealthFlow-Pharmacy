import { getCurrentSupabaseUser, invokeSupabaseFunction, supabase } from '../lib/supabase'
import { assertRequiredText, normalizeText } from '../utils/validation'
import { STAFF_ROLE_VALUES } from '../utils/roles'
import { normalizeGhanaRegion } from '../utils/ghanaRegions'
import { tryLogAuditEvent } from './auditService'
// ✅ NHIS PHARMACY LEVEL PATCH START
import { normalizePharmacyLevel } from '../utils/nhisPharmacyLevel'
// ✅ NHIS PHARMACY LEVEL PATCH END

const STAFF_ADMIN_FUNCTION = 'staff-admin'

const OPTIONAL_SETTINGS_COLUMNS = [
  'pharmacy_level',
  'facility_type',
  'website',
  'report_footer',
  'theme_primary_color',
  'theme_secondary_color',
  'theme_accent_color',
  'custom_header',
  'report_template',
]

// ✅ NHIS PHARMACY LEVEL PATCH START
const getMissingOptionalSettingsColumn = (error, payload = {}) => {
  const message = String(error?.message || error?.details || '').toLowerCase()
  if (!error || !(error.code === 'PGRST204' || message.includes('schema cache') || message.includes('column'))) {
    return null
  }

  return OPTIONAL_SETTINGS_COLUMNS.find(
    (column) =>
      Object.prototype.hasOwnProperty.call(payload, column) &&
      (message.includes(column.toLowerCase()) || error.code === 'PGRST204')
  ) || null
}

const withoutOptionalSettingsColumn = (payload, column) => {
  const nextPayload = { ...payload }
  delete nextPayload[column]
  return nextPayload
}
// ✅ NHIS PHARMACY LEVEL PATCH END

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
    pharmacyName: 'Facility',
  })
}

export const updatePharmacySettings = async (id, settings) => {
  const payload = {
    pharmacy_name: normalizeText(settings.pharmacyName),
    phone: normalizeText(settings.phone) || null,
    email: normalizeText(settings.email) || null,
    address: normalizeText(settings.address) || null,
    city: normalizeText(settings.city) || null,
    region: normalizeGhanaRegion(settings.region) || null,
    facility_type: normalizeText(settings.facilityType ?? settings.facility_type) || null,
    website: normalizeText(settings.website) || null,
    logo_url: normalizeText(settings.logoUrl ?? settings.logo_url) || null,
    slogan: normalizeText(settings.slogan) || null,
    license_number: normalizeText(settings.licenseNumber) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacy_level: normalizePharmacyLevel(settings.pharmacyLevel) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH END
    tax_rate: Number.parseFloat(settings.taxRate || 0),
    currency: normalizeText(settings.currency) || 'GHS',
    default_markup_percent: Number.parseFloat(settings.defaultMarkupPercent || 0),
    low_stock_threshold: Number.parseFloat(settings.lowStockThreshold || 10),
    expiry_alert_days: Number.parseInt(settings.expiryAlertDays || 30, 10),
    receipt_footer: normalizeText(settings.receiptFooter) || null,
    report_footer: normalizeText(settings.reportFooter ?? settings.report_footer) || null,
    theme_primary_color: normalizeText(settings.themePrimaryColor ?? settings.theme_primary_color) || null,
    theme_secondary_color: normalizeText(settings.themeSecondaryColor ?? settings.theme_secondary_color) || null,
    theme_accent_color: normalizeText(settings.themeAccentColor ?? settings.theme_accent_color) || null,
    custom_header: normalizeText(settings.customHeader ?? settings.custom_header) || null,
    report_template: normalizeText(settings.reportTemplate ?? settings.report_template) || null,
    updated_at: new Date().toISOString(),
  }

  const organizationId = await getCurrentOrganizationId()
  if (organizationId) {
    payload.organization_id = organizationId
  }

  const runUpdate = async (updatePayload) => {
    let query = supabase
      .from('pharmacy_settings')
      .update(updatePayload)
      .select()

    if (id) {
      query = query.eq('id', id)
    } else if (organizationId) {
      query = query.eq('organization_id', organizationId)
    } else {
      throw new Error('Unable to determine which pharmacy settings to update.')
    }

    return await query.single()
  }

  let updatePayload = payload
  let { data, error } = await runUpdate(updatePayload)
  // ✅ NHIS PHARMACY LEVEL PATCH START
  let missingColumn = getMissingOptionalSettingsColumn(error, updatePayload)
  while (error && missingColumn) {
    updatePayload = withoutOptionalSettingsColumn(updatePayload, missingColumn)
    ;({ data, error } = await runUpdate(updatePayload))
    missingColumn = getMissingOptionalSettingsColumn(error, updatePayload)
  }
  // ✅ NHIS PHARMACY LEVEL PATCH END

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
      normalizeText(settings.pharmacy_name ?? settings.pharmacyName) || 'Facility',
    phone: normalizeText(settings.phone) || null,
    email: normalizeText(settings.email) || null,
    address: normalizeText(settings.address) || null,
    city: normalizeText(settings.city) || null,
    region: normalizeGhanaRegion(settings.region) || null,
    facility_type: normalizeText(settings.facility_type ?? settings.facilityType) || null,
    website: normalizeText(settings.website) || null,
    logo_url: normalizeText(settings.logo_url ?? settings.logoUrl) || null,
    slogan: normalizeText(settings.slogan) || null,
    license_number: normalizeText(settings.license_number ?? settings.licenseNumber) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacy_level: normalizePharmacyLevel(settings.pharmacy_level ?? settings.pharmacyLevel) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH END
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
    report_footer: normalizeText(settings.report_footer ?? settings.reportFooter) || null,
    theme_primary_color: normalizeText(settings.theme_primary_color ?? settings.themePrimaryColor) || null,
    theme_secondary_color: normalizeText(settings.theme_secondary_color ?? settings.themeSecondaryColor) || null,
    theme_accent_color: normalizeText(settings.theme_accent_color ?? settings.themeAccentColor) || null,
    custom_header: normalizeText(settings.custom_header ?? settings.customHeader) || null,
    report_template: normalizeText(settings.report_template ?? settings.reportTemplate) || null,
  }

  const organizationId =
    normalizeText(settings.organization_id ?? settings.organizationId) || null

  if (organizationId) {
    payload.organization_id = organizationId
  }

  const runInsert = async (insertPayload) =>
    await supabase
      .from('pharmacy_settings')
      .insert([insertPayload])
      .select()
      .single()

  let insertPayload = payload
  let { data, error } = await runInsert(insertPayload)

  // ✅ NHIS PHARMACY LEVEL PATCH START
  let missingColumn = getMissingOptionalSettingsColumn(error, insertPayload)
  while (error && missingColumn) {
    insertPayload = withoutOptionalSettingsColumn(insertPayload, missingColumn)
    ;({ data, error } = await runInsert(insertPayload))
    missingColumn = getMissingOptionalSettingsColumn(error, insertPayload)
  }
  // ✅ NHIS PHARMACY LEVEL PATCH END

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
  const response = await invokeStaffAdmin({
    action: 'set_staff_branch',
    userId: assertRequiredText(userId, 'User id'),
    branchId: normalizeText(branchId) || null,
  })

  return response.user
}
