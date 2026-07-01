import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  buildDefaultMedicationRowsForOrganization,
  DEFAULT_MEDICATION_BATCH_PREFIX,
  isDefaultMedicationBatchNumber,
} from '../_shared/defaultMedicationCatalog.ts'
import {
  getExistingDrugSaveAction,
} from '../_shared/drugInventory.ts'
import { resolveTierAccess } from '../_shared/tier.ts'

const USERS_PER_PAGE = 200
const MAX_USER_PAGES = 10
const CATALOG_SYNC_BATCH_SIZE = 200
const DRUGS_PER_PAGE = 1000
const NHIS_CATALOG_PAGE_SIZE = 1000
const CLAIM_SELECT_FIELDS = `
  *,
  claim_items (*),
  patients (full_name, phone, insurance_provider),
  branches (id, name, code),
  users:submitted_by (full_name)
`
const SALES_SELECT_FIELDS = `
  *,
  sale_items (
    *,
    drugs (name)
  ),
  patients (id, full_name, phone, insurance_provider, insurance_id)
`
const REPORT_DRUG_SELECT_FIELDS = `
  id,
  organization_id,
  branch_id,
  name,
  batch_number,
  expiry_date,
  quantity,
  unit,
  price,
  cost_price,
  nhis_code,
  nhis_price,
  nhis_unit,
  supplier,
  category,
  reorder_level,
  status,
  created_at
`
const EPHARMACY_ORG_SELECT_FIELDS = `
  id,
  name,
  organization_type,
  address,
  city,
  region,
  phone,
  email,
  license_number,
  epharmacy_enabled,
  epharmacy_certificate_number,
  epharmacy_license_status,
  pharmacist_in_charge_name,
  pharmacist_in_charge_reg_no,
  epharmacy_contact_phone,
  epharmacy_contact_email,
  epharmacy_pickup_enabled,
  epharmacy_delivery_enabled,
  epharmacy_delivery_zones,
  epharmacy_minimum_order_amount,
  epharmacy_terms_accepted_at,
  epharmacy_updated_at
`
const EPHARMACY_DRUG_SELECT_FIELDS = `
  id,
  organization_id,
  branch_id,
  name,
  brand_name,
  generic_name,
  batch_number,
  expiry_date,
  quantity,
  unit,
  price,
  cost_price,
  supplier,
  category,
  description,
  reorder_level,
  status,
  medicine_access_level,
  required_pharmacy_level,
  epharmacy_visible,
  epharmacy_interfacility_visible,
  epharmacy_customer_visible,
  epharmacy_requires_prescription,
  epharmacy_sale_class,
  epharmacy_pickup_enabled,
  epharmacy_delivery_enabled,
  epharmacy_warning,
  epharmacy_updated_at,
  branches (id, name, code)
`

type TierAccessAction =
  | 'get_drugs'
  | 'get_claims'
  | 'get_claims_workspace'
  | 'get_patients_workspace'
  | 'get_recent_claims'
  | 'get_claims_statistics'
  | 'create_claim'
  | 'update_claim'
  | 'approve_claim'
  | 'reject_claim'
  | 'get_report_bundle'
  | 'get_report_health'
  | 'get_report_nhis_page'
  | 'create_drug'
  | 'update_drug'
  | 'delete_drug'
  | 'bulk_import_drugs'
  | 'sync_nhis_drugs_to_inventory'
  | 'get_nhia_api_settings'
  | 'save_nhia_api_settings'
  | 'remove_nhia_api_credentials'
  | 'generate_nhia_cc_code'
  | 'generate_cc_code'
  | 'request_cc_code'
  | 'generate_cc'
  | 'submit_nhia_claims_direct'
  | 'submit_nhis_pharmacy_claim'
  | 'test_claimit_connection'
  | 'get_epharmacy_marketplace'
  | 'save_epharmacy_profile'
  | 'update_epharmacy_listing_controls'
  | 'create_epharmacy_order'
  | 'update_epharmacy_order_status'
  | 'get_activity_logs'

const SUPPORTED_TIER_ACCESS_ACTIONS = [
  'get_drugs',
  'get_claims',
  'get_claims_workspace',
  'get_patients_workspace',
  'get_recent_claims',
  'get_claims_statistics',
  'create_claim',
  'update_claim',
  'approve_claim',
  'reject_claim',
  'get_report_bundle',
  'get_report_health',
  'get_report_nhis_page',
  'create_drug',
  'update_drug',
  'delete_drug',
  'bulk_import_drugs',
  'sync_nhis_drugs_to_inventory',
  'get_nhia_api_settings',
  'save_nhia_api_settings',
  'remove_nhia_api_credentials',
  'test_claimit_connection',
  'generate_nhia_cc_code',
  'generate_cc_code',
  'request_cc_code',
  'generate_cc',
  'submit_nhia_claims_direct',
  'submit_nhis_pharmacy_claim',
  'get_epharmacy_marketplace',
  'save_epharmacy_profile',
  'update_epharmacy_listing_controls',
  'create_epharmacy_order',
  'update_epharmacy_order_status',
  'get_activity_logs',
]

const NHIA_CC_CODE_ACTIONS = new Set([
  'generate_nhia_cc_code',
  'generate_cc_code',
  'request_cc_code',
  'generate_cc',
])

type RequesterProfile = {
  id: string
  role: string
  assigned_roles: string[]
  active_role_enforced?: boolean
  organization_id: string | null
  branch_id: string | null
  can_manage_inventory: boolean
  can_view_reports: boolean
  can_manage_claims: boolean
  can_manage_patients: boolean
  can_manage_epharmacy: boolean
  can_view_activity_log: boolean
  can_adjust_stock: boolean
}

const INVENTORY_ROLES = ['admin', 'pharmacist', 'technician', 'procurement', 'inventory_officer', 'branch_manager']
const SALES_ROLES = ['admin', 'pharmacist', 'assistant', 'cashier', 'technician', 'branch_manager']
const CLAIMS_ROLES = ['admin', 'pharmacist', 'billing', 'claims_officer']
const PATIENT_ROLES = [
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
const NHIS_ROLES = ['admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer']
const REPORT_ROLES = [
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
const NHIA_SETTINGS_ROLES = ['admin', 'pharmacist', 'branch_manager']
const EPHARMACY_ROLES = ['admin', 'pharmacist', 'procurement', 'inventory_officer', 'branch_manager']
const EPHARMACY_REVIEW_ROLES = ['admin', 'pharmacist']
const ACTIVITY_LOG_ROLES = ['admin', 'branch_manager', 'super_admin']
// ✅ NHIS PHARMACY LEVEL PATCH START
const VALID_PHARMACY_LEVELS = ['P1', 'P2', 'LCS', 'HP']
const VALID_MEDICINE_ACCESS_LEVELS = ['OTC', 'Prescription', 'Specialist', 'Controlled']
const VALID_EPHARMACY_SALE_CLASSES = ['otc', 'prescription', 'restricted', 'controlled', 'narcotic']
const BLOCKED_EPHARMACY_SALE_CLASSES = new Set(['restricted', 'controlled', 'narcotic'])
const EPHARMACY_REVIEW_SALE_CLASSES = new Set(['prescription', 'restricted', 'controlled', 'narcotic'])
const EPHARMACY_ORDER_STATUSES = [
  'pending_review',
  'approved',
  'rejected',
  'paid',
  'packed',
  'out_for_delivery',
  'delivered',
  'cancelled',
]
const EPHARMACY_FULFILLMENT_METHODS = ['pickup', 'delivery']
const EPHARMACY_PAYMENT_METHODS = ['none', 'paystack', 'momo', 'card', 'cash_on_delivery', 'account_transfer', 'credit']
// ✅ NHIS PHARMACY LEVEL PATCH END

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const toIlikeSearchTerm = (value: unknown) =>
  normalizeText(value).replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim()
const normalizeHttpHeaderValue = (value: unknown) => {
  let normalized = normalizeText(value).replace(/[\u0000-\u001F\u007F]/g, '')
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim()
  }
  return normalized
}

const REDACTED_VALUE = '[REDACTED]'

class NhiaSettingsValidationError extends Error {
  integrationMode: string
  missingFields: string[]

  constructor(integrationMode: string, missingFields: string[]) {
    super(`NHIA configuration is incomplete for ${integrationMode}: missing ${missingFields.join(', ')}.`)
    this.name = 'NhiaSettingsValidationError'
    this.integrationMode = integrationMode
    this.missingFields = missingFields
  }
}

const getNhiaValidationDetails = (error: unknown) => {
  if (error instanceof NhiaSettingsValidationError) {
    return {
      integrationMode: error.integrationMode,
      missingFields: error.missingFields,
    }
  }

  return null
}

const shouldRedactTierAccessField = (key: string) => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    normalized === 'credentials' ||
    normalized.includes('apikey') ||
    normalized.includes('apisecret') ||
    normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('authorization') ||
    normalized.includes('encrypted') ||
    normalized.includes('secret')
  )
}

const redactTierAccessBody = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redactTierAccessBody(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      shouldRedactTierAccessField(key) ? REDACTED_VALUE : redactTierAccessBody(entry),
    ])
  )
}

const NHIS_SERVICE_TIME_ZONE = 'Africa/Accra'

const toNhisCalendarDate = (value: unknown = new Date()) => {
  const date = value instanceof Date ? value : new Date(String(value || ''))
  if (Number.isNaN(date.getTime())) return ''

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: NHIS_SERVICE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
    return [part('year'), part('month'), part('day')].filter(Boolean).join('-')
  } catch {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')
  }
}

const normalizeNhiaServiceDate = (value: unknown) => {
  const raw = normalizeText(value)
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) {
    const [, day, month, year] = dmy
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return toNhisCalendarDate(raw)
}

const normalizeNhiaAccreditationExpiryDate = (value: unknown) => {
  const raw = normalizeText(value)
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const isoDate = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]/)?.[1]
  if (isoDate) return isoDate

  const localDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (localDate) {
    const [, day, month, year] = localDate
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

const getNhiaAccreditationExpiryDate = (...sources: unknown[]) =>
  normalizeNhiaAccreditationExpiryDate(
    sources.map((source) => {
      if (!source || typeof source !== 'object') return source
      const payload = source as Record<string, unknown>
      return normalizeText(
        payload.accreditationExpiryDate ||
          payload.accreditationExpiry ||
          payload.nhiaAccreditationExpiry ||
          payload.accreditation_expiry_date ||
          payload.expiryDate
      )
    }).find(Boolean)
  )

const normalizeOrganizationType = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase()
  return normalized === 'hospital' ? 'hospital' : 'pharmacy'
}

const normalizeSearchTokens = (value: unknown) =>
  normalizeText(value)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

const NHIS_CATALOG_TOKEN_ALIASES: Record<string, string> = {
  aciclovir: 'acyclovir',
}

const NHIS_CATALOG_STOP_TOKENS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'or', 'the', 'to', 'with'])

const normalizeNhisCatalogText = (value: unknown) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/&/g, ' and ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => NHIS_CATALOG_TOKEN_ALIASES[token] || token)
    .filter(Boolean)
    .join(' ')
    .trim()

const getNhisCatalogTokens = (value: unknown) =>
  normalizeNhisCatalogText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !NHIS_CATALOG_STOP_TOKENS.has(token))

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }

  if (error && typeof error === 'object') {
    const message = normalizeText((error as Record<string, unknown>).message)
    const details = normalizeText((error as Record<string, unknown>).details)
    const hint = normalizeText((error as Record<string, unknown>).hint)
    return [message, details, hint].filter(Boolean).join(' ') || 'Unexpected tier access error.'
  }

  return 'Unexpected tier access error.'
}

const DEFAULT_CATALOG_BATCH_ERROR =
  'Batch numbers starting with PDF-IMP- are reserved for the shared default medicine catalog.'
const DEFAULT_CATALOG_DELETE_ERROR =
  'Default catalog medicines stay available to all pharmacies and cannot be deleted.'
const DEFAULT_CATALOG_IDENTITY_ERROR =
  'Default catalog medicines keep their shared name and catalog code. Update quantity or pricing instead.'
const PATIENT_WORKSPACE_MAX_PATIENTS = 5000
const PATIENT_WORKSPACE_MAX_NHIS_CLAIMS = 1000
const PATIENT_WORKSPACE_DEFAULT_PAGE_SIZE = 100
const PATIENT_WORKSPACE_MAX_PAGE_SIZE = 500
const REPORT_BUNDLE_MAX_ROWS = 1000
const REPORT_BUNDLE_MAX_NHIS_CLAIMS = 250
const REPORT_BUNDLE_DEFAULT_NHIS_CLAIMS = 200
const REPORT_AGGREGATE_PAGE_SIZE = 500

const PATIENT_WORKSPACE_PATIENT_SELECT_FIELDS = [
  'id',
  'organization_id',
  'full_name',
  'phone',
  'email',
  'gender',
  'date_of_birth',
  'address',
  'insurance_provider',
  'insurance_id',
  'created_at',
].join(', ')

const PATIENT_WORKSPACE_NHIS_CLAIM_SELECT_FIELDS = [
  'id',
  'claim_number',
  'patient_id',
  'member_no',
  'hin',
  'surname',
  'other_names',
  'gender',
  'date_of_birth',
  'folder_no',
  'service_date_from',
  'created_at',
].join(', ')

const parseOptionalDate = (value: unknown) => {
  const normalized = normalizeText(value)
  if (!normalized) {
    return null
  }

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date value.')
  }

  return parsed.toISOString()
}

const parsePositiveInteger = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const clampPositiveInteger = (value: unknown, fallback: number, max: number) =>
  Math.min(parsePositiveInteger(value, fallback), max)

const parseNonNegativeNumber = (value: unknown, label: string) => {
  const parsed = Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a valid non-negative number.`)
  }

  return parsed
}

const assertRequiredText = (value: unknown, label: string) => {
  const normalized = normalizeText(value)
  if (!normalized) {
    throw new Error(`${label} is required.`)
  }

  return normalized
}

const getFunctionEnv = () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey =
    Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase function environment. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SERVICE_ROLE_KEY.'
    )
  }

  return {
    supabaseUrl,
    supabaseAnonKey,
    serviceRoleKey,
  }
}

const createUserClient = (supabaseUrl: string, supabaseAnonKey: string, authorization: string) =>
  createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: authorization,
      },
    },
  })

const createAdminClient = (supabaseUrl: string, serviceRoleKey: string) =>
  createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

const isMissingUserPrivilegeColumn = (error: unknown) => {
  const payload = error as { code?: string; status?: number; statusCode?: number; message?: string; details?: string }
  const message = normalizeText(payload?.message || payload?.details).toLowerCase()
  const status = Number(payload?.status || payload?.statusCode || 0)
  return (
    status === 400 ||
    payload?.code === '42703' ||
    payload?.code === 'PGRST204' ||
    message.includes('assigned_roles')
  )
}

const getRequesterProfile = async (
  adminClient: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<RequesterProfile | null> => {
  const runQuery = async (columns: string) =>
    await adminClient
      .from('users')
      .select(columns)
      .eq('id', userId)
      .maybeSingle()

  let { data, error } = await runQuery('id, role, assigned_roles, organization_id, branch_id, can_manage_inventory, can_view_reports, can_manage_claims, can_manage_patients, can_manage_epharmacy, can_view_activity_log, can_adjust_stock')

  if (error && isMissingUserPrivilegeColumn(error)) {
    const legacyResult = await runQuery('id, role, organization_id, branch_id, can_manage_inventory, can_view_reports, can_manage_claims, can_manage_patients, can_manage_epharmacy, can_adjust_stock')
    data = legacyResult.data
      ? {
          ...legacyResult.data,
          assigned_roles: [legacyResult.data.role].filter(Boolean),
        }
      : legacyResult.data
    error = legacyResult.error
  }

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  return {
    id: data.id,
    role: normalizeText(data.role).toLowerCase(),
    assigned_roles: Array.isArray(data.assigned_roles)
      ? data.assigned_roles.map((role: unknown) => normalizeText(role).toLowerCase()).filter(Boolean)
      : [],
    organization_id: normalizeText(data.organization_id) || null,
    branch_id: normalizeText(data.branch_id) || null,
    can_manage_inventory: Boolean(data.can_manage_inventory),
    can_view_reports: Boolean(data.can_view_reports),
    can_manage_claims: Boolean(data.can_manage_claims),
    can_manage_patients: Boolean(data.can_manage_patients),
    can_manage_epharmacy: Boolean(data.can_manage_epharmacy),
    can_view_activity_log: Boolean(data.can_view_activity_log),
    can_adjust_stock: Boolean(data.can_adjust_stock),
  }
}

const getOrganizationTierContext = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const { data: organization, error } = await adminClient
    .from('organizations')
    .select('id, status, billing_status, subscription_tier, trial_ends_at, subscription_ends_at, can_use_claims')
    .eq('id', organizationId)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!organization) {
    throw new Error('Organization not found.')
  }

  return resolveTierAccess(organization)
}

const requireRequester = async (
  request: Request,
  adminClient: ReturnType<typeof createAdminClient>,
  supabaseUrl: string,
  supabaseAnonKey: string
) => {
  const authorization = request.headers.get('Authorization')
  if (!authorization) {
    return { error: json({ error: 'Missing authorization header.' }, 401) }
  }

  const userClient = createUserClient(supabaseUrl, supabaseAnonKey, authorization)
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser()

  if (authError || !user) {
    return { error: json({ error: 'You must be signed in to continue.' }, 401) }
  }

  const requesterProfile = await getRequesterProfile(adminClient, user.id)
  if (!requesterProfile) {
    return { error: json({ error: 'Unable to determine your organization context.' }, 403) }
  }

  if (!requesterProfile.organization_id) {
    return { error: json({ error: 'Current account is missing organization context.' }, 400) }
  }

  return {
    requesterProfile,
    organizationId: requesterProfile.organization_id,
  }
}

const requireTierFeature = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  feature: 'claims' | 'reports' | 'advanced_inventory'
) => {
  const tierContext = await getOrganizationTierContext(adminClient, organizationId)

  if (tierContext.isSuspended) {
    throw new Error('This pharmacy is locked. Contact platform support to restore access.')
  }

  if (feature === 'claims' && !tierContext.tierLimits.hasClaims) {
    throw new Error('Claims are locked for this pharmacy. Enable the Claims module from Tenant Admin.')
  }

  if (feature === 'reports' && !tierContext.tierLimits.hasReports) {
    throw new Error('Reports are available on Professional or Enterprise plans.')
  }

  if (feature === 'advanced_inventory' && !tierContext.tierLimits.hasAdvancedInventory) {
    throw new Error('Bulk inventory import is available on Professional or Enterprise plans.')
  }

  return tierContext
}

const requireRole = (
  requesterProfile: RequesterProfile,
  allowedRoles: string[],
  message: string
) => {
  if (!requesterHasAnyRole(requesterProfile, ['admin', ...allowedRoles])) {
    throw new Error(message)
  }
}

const requesterHasAnyRole = (requesterProfile: RequesterProfile, roles: string[]) =>
  requesterProfile.active_role_enforced
    ? roles.includes(requesterProfile.role)
    : roles.some((role) =>
        role === requesterProfile.role || requesterProfile.assigned_roles.includes(role)
      )

const applyRequestedActiveRole = (
  requesterProfile: RequesterProfile,
  requestedRole: unknown
): RequesterProfile => {
  const activeRole = normalizeText(requestedRole).toLowerCase()
  if (!activeRole) return requesterProfile

  const availableRoles = [...new Set([requesterProfile.role, ...requesterProfile.assigned_roles])]
  if (!availableRoles.includes(activeRole)) {
    throw new Error('The selected active role is not assigned to this user.')
  }

  return {
    ...requesterProfile,
    role: activeRole,
    active_role_enforced: true,
  }
}

const requireInventoryAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (!requesterHasAnyRole(requesterProfile, INVENTORY_ROLES) && !requesterProfile.can_manage_inventory) {
    throw new Error(message)
  }
}

const requireStockAdjustmentAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !requesterHasAnyRole(requesterProfile, INVENTORY_ROLES) &&
    !requesterProfile.can_manage_inventory &&
    !requesterProfile.can_adjust_stock
  ) {
    throw new Error(message)
  }
}

const requireClaimsAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (requesterProfile.active_role_enforced && requesterProfile.role === 'assistant') {
    throw new Error(message)
  }
  if (!requesterHasAnyRole(requesterProfile, CLAIMS_ROLES) && !requesterProfile.can_manage_claims) {
    throw new Error(message)
  }
}

const requirePatientAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !requesterHasAnyRole(requesterProfile, PATIENT_ROLES) &&
    !requesterProfile.can_manage_claims &&
    !requesterProfile.can_manage_patients
  ) {
    throw new Error(message)
  }
}

const requireNhisCatalogAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !requesterHasAnyRole(requesterProfile, NHIS_ROLES) &&
    !requesterHasAnyRole(requesterProfile, INVENTORY_ROLES) &&
    !requesterProfile.can_manage_inventory &&
    !requesterProfile.can_manage_claims
  ) {
    throw new Error(message)
  }
}

const requireNhiaAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !requesterHasAnyRole(requesterProfile, NHIS_ROLES) &&
    !requesterHasAnyRole(requesterProfile, NHIA_SETTINGS_ROLES) &&
    !requesterProfile.can_manage_claims
  ) {
    throw new Error(message)
  }
}

const requireNhiaSettingsAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (!requesterHasAnyRole(requesterProfile, NHIA_SETTINGS_ROLES) && !requesterProfile.can_manage_claims) {
    throw new Error(message)
  }
}

const resolveScopedBranchId = (
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown> = {}
) => requesterProfile.branch_id || normalizeText(payload.branchId || payload.branch_id)

const requireClaimCreateAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !requesterHasAnyRole(requesterProfile, CLAIMS_ROLES) &&
    !requesterProfile.can_manage_claims &&
    !requesterHasAnyRole(requesterProfile, SALES_ROLES)
  ) {
    throw new Error(message)
  }
}

const requireReportsAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (!requesterHasAnyRole(requesterProfile, REPORT_ROLES) && !requesterProfile.can_view_reports) {
    throw new Error(message)
  }
}

const requireEpharmacyAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !requesterHasAnyRole(requesterProfile, EPHARMACY_ROLES) &&
    !requesterProfile.can_manage_inventory &&
    !requesterProfile.can_manage_epharmacy
  ) {
    throw new Error(message)
  }
}

const requireActivityLogAccess = (requesterProfile: RequesterProfile) => {
  if (
    !requesterHasAnyRole(requesterProfile, ACTIVITY_LOG_ROLES) &&
    !requesterProfile.can_view_activity_log
  ) {
    throw new Error('You do not have permission to view activity logs.')
  }
}

const normalizeEpharmacySaleClass = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase().replace(/\s+/g, '_')
  return VALID_EPHARMACY_SALE_CLASSES.includes(normalized) ? normalized : 'otc'
}

const normalizeEpharmacyStatus = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase()
  if (!EPHARMACY_ORDER_STATUSES.includes(normalized)) {
    throw new Error('Invalid e-pharmacy order status.')
  }
  return normalized
}

const normalizeEpharmacyFulfillmentMethod = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase()
  return EPHARMACY_FULFILLMENT_METHODS.includes(normalized) ? normalized : 'pickup'
}

const normalizeEpharmacyPaymentMethod = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase()
  return EPHARMACY_PAYMENT_METHODS.includes(normalized) ? normalized : 'none'
}

const isExpiredDate = (value: unknown) => {
  const raw = normalizeText(value)
  if (!raw) return true
  const expiry = new Date(`${raw}T23:59:59`)
  return Number.isNaN(expiry.getTime()) || expiry.getTime() < Date.now()
}

const getEpharmacySurplusQuantity = (drug: Record<string, unknown>) => {
  const quantity = Number(drug.quantity || 0)
  const reorderLevel = Number(drug.reorder_level || 0)
  return Math.max(0, quantity - Math.max(0, reorderLevel))
}

const buildEpharmacyOrderNumber = () => {
  const stamp = Date.now().toString(36).toUpperCase()
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()
  return `EPH-${stamp}-${suffix}`
}

const tryWriteTierAuditEvent = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  event: {
    eventType: string
    entityType: string
    entityId?: string | null
    action: string
    details?: Record<string, unknown>
  }
) => {
  try {
    await adminClient.from('audit_logs').insert({
      actor_user_id: requesterProfile.id,
      event_type: event.eventType,
      entity_type: event.entityType,
      entity_id: event.entityId || null,
      action: event.action,
      details: event.details || {},
      organization_id: organizationId,
      created_at: new Date().toISOString(),
    })
  } catch (error) {
    console.warn('tier-access audit warning:', getErrorMessage(error))
  }
}

const getActivityLogs = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireActivityLogAccess(requesterProfile)

  const limit = Math.min(parsePositiveInteger(payload.limit, 200), 500)
  const { data: staffRows, error: staffError } = await adminClient
    .from('users')
    .select('id')
    .eq('organization_id', organizationId)

  if (staffError) {
    throw staffError
  }

  const staffIds = (staffRows || [])
    .map((row) => normalizeText(row.id))
    .filter(Boolean)

  let query = adminClient
    .from('audit_logs')
    .select('id, actor_user_id, actor_email, event_type, entity_type, action, details, organization_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (staffIds.length) {
    query = query.or(`organization_id.eq.${organizationId},actor_user_id.in.(${staffIds.join(',')})`)
  } else {
    query = query.eq('organization_id', organizationId)
  }

  const { data, error } = await query
  if (error) {
    throw error
  }

  return { logs: data || [] }
}

const getDrugCount = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId: string | null = null
) => {
  let query = adminClient
    .from('drugs')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .not('batch_number', 'ilike', `${DEFAULT_MEDICATION_BATCH_PREFIX}%`)

  if (branchId) {
    query = query.eq('branch_id', branchId)
  }

  const { count, error } = await query

  if (error) {
    throw error
  }

  return count || 0
}

const syncDefaultMedicationCatalog = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId: string | null = null
) => {
  const { data: existingCatalogRows, error } = await adminClient
    .from('drugs')
    .select('id, organization_id, branch_id, batch_number, status')
    .ilike('batch_number', `${DEFAULT_MEDICATION_BATCH_PREFIX}%`)

  if (error) {
    throw error
  }

  const currentOrganizationCatalogRows = (existingCatalogRows || []).filter(
    (row) =>
      normalizeText(row.organization_id) === organizationId &&
      (!branchId || normalizeText(row.branch_id) === branchId)
  )

  const existingBatchNumbers = new Set(
    currentOrganizationCatalogRows
      .map((row) => normalizeText(row.batch_number).toUpperCase())
      .filter(Boolean)
  )

  const claimableCatalogIds = branchId ? [] : (existingCatalogRows || [])
    .filter((row) => {
      const batchNumber = normalizeText(row.batch_number).toUpperCase()
      return !normalizeText(row.organization_id) && batchNumber && !existingBatchNumbers.has(batchNumber)
    })
    .map((row) => row.id)

  if (claimableCatalogIds.length > 0) {
    const { error: claimError } = await adminClient
      .from('drugs')
      .update({
        organization_id: organizationId,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .in('id', claimableCatalogIds)

    if (claimError) {
      throw claimError
    }
  }

  const inactiveCatalogIds = currentOrganizationCatalogRows
    .filter((row) => normalizeText(row.status).toLowerCase() !== 'active')
    .map((row) => row.id)

  if (inactiveCatalogIds.length > 0) {
    const { error: reactivateError } = await adminClient
      .from('drugs')
      .update({
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .in('id', inactiveCatalogIds)

    if (reactivateError) {
      throw reactivateError
    }
  }

  const missingRows = buildDefaultMedicationRowsForOrganization(organizationId, existingBatchNumbers)
    .map((row) => ({
      ...row,
      branch_id: branchId || null,
    }))

  for (let index = 0; index < missingRows.length; index += CATALOG_SYNC_BATCH_SIZE) {
    const batch = missingRows.slice(index, index + CATALOG_SYNC_BATCH_SIZE)
    const { error: insertError } = await adminClient.from('drugs').upsert(batch, {
      onConflict: 'organization_id,branch_id,name,batch_number',
      ignoreDuplicates: true,
    })

    if (insertError) {
      throw insertError
    }
  }
}

const getBranchIdForInventoryRequest = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  const requestedBranchId = normalizeText(payload.branchId)
  const branchId = requestedBranchId || requesterProfile.branch_id

  if (!branchId) {
    return null
  }

  const { data, error } = await adminClient
    .from('branches')
    .select('id')
    .eq('id', branchId)
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error('Selected branch could not be found.')
  }

  return branchId
}

const getBranchIdsForInventorySync = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  const explicitBranchId = normalizeText(payload.branchId) || requesterProfile.branch_id
  if (explicitBranchId) {
    return [
      await getBranchIdForInventoryRequest(adminClient, organizationId, requesterProfile, payload),
    ].filter(Boolean) as string[]
  }

  const { data, error } = await adminClient
    .from('branches')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .order('is_main', { ascending: false })
    .order('name')

  if (error) {
    throw error
  }

  const branchIds = (data || []).map((branch) => normalizeText(branch.id)).filter(Boolean)
  if (branchIds.length > 0) {
    return branchIds
  }

  return [null]
}

type NhisCatalogLookup = {
  row: Record<string, unknown>
  code: string
  description: string
  unit: string
  unitPrice: number
  category: string
  normalizedDescription: string
  descriptionTokens: string[]
}

type NhisCatalogMatch = {
  lookup: NhisCatalogLookup
  source: 'code' | 'name'
  score: number
}

const loadNhisDrugCatalogRows = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const rows: Record<string, unknown>[] = []
  let from = 0

  while (true) {
    const to = from + NHIS_CATALOG_PAGE_SIZE - 1
    const { data, error } = await adminClient
      .from('nhis_drugs')
      .select('id, code, description, generic_name, strength, dosage_form, category, unit, unit_price')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('description')
      .range(from, to)

    if (error) {
      const code = normalizeText((error as Record<string, unknown>).code)
      if (code === '42P01' || code === 'PGRST205') {
        return []
      }

      throw error
    }

    rows.push(...((data || []) as Record<string, unknown>[]))

    if (!data || data.length < NHIS_CATALOG_PAGE_SIZE) {
      break
    }

    from += NHIS_CATALOG_PAGE_SIZE
  }

  return rows
}

const buildNhisCatalogLookups = (rows: Record<string, unknown>[]) =>
  rows
    .map((row) => {
      const description = normalizeText(row.description)
      const code = normalizeText(row.code).toUpperCase()
      const normalizedDescription = normalizeNhisCatalogText(description)
      const descriptionTokens = [...new Set(getNhisCatalogTokens(description))]

      return {
        row,
        code,
        description,
        unit: normalizeText(row.unit) || 'unit',
        unitPrice: Number(row.unit_price ?? 0) || 0,
        category: normalizeText(row.category),
        normalizedDescription,
        descriptionTokens,
      }
    })
    .filter((lookup) => lookup.code && lookup.description && lookup.normalizedDescription)

const scoreNhisCatalogNameMatch = (
  normalizedDrugName: string,
  drugTokens: Set<string>,
  lookup: NhisCatalogLookup
) => {
  if (!normalizedDrugName || lookup.descriptionTokens.length < 2) {
    return 0
  }

  if (normalizedDrugName === lookup.normalizedDescription) {
    return 10000 + lookup.descriptionTokens.length
  }

  if (normalizedDrugName.includes(lookup.normalizedDescription)) {
    return 9000 + lookup.descriptionTokens.length
  }

  const matchedTokenCount = lookup.descriptionTokens.filter((token) => drugTokens.has(token)).length
  const allCatalogTokensPresent = matchedTokenCount === lookup.descriptionTokens.length

  if (allCatalogTokensPresent) {
    return 8000 + matchedTokenCount
  }

  const coverage = matchedTokenCount / lookup.descriptionTokens.length
  if (lookup.descriptionTokens.length >= 4 && coverage >= 0.9) {
    return 7000 + matchedTokenCount
  }

  return 0
}

const findBestNhisCatalogMatch = (
  drug: Record<string, unknown>,
  lookups: NhisCatalogLookup[],
  lookupsByCode: Map<string, NhisCatalogLookup>
): NhisCatalogMatch | null => {
  const existingCode = normalizeText(drug.nhis_code).toUpperCase()
  if (existingCode && lookupsByCode.has(existingCode)) {
    return {
      lookup: lookupsByCode.get(existingCode)!,
      source: 'code',
      score: 20000,
    }
  }

  let bestMatch: NhisCatalogMatch | null = null
  const normalizedDrugName = normalizeNhisCatalogText(drug.name)
  const drugTokens = new Set(getNhisCatalogTokens(drug.name))
  const drugTokenCount = drugTokens.size
  for (const lookup of lookups) {
    const score = scoreNhisCatalogNameMatch(normalizedDrugName, drugTokens, lookup)
    if (!score) {
      continue
    }

    const tokenDelta = Math.abs(drugTokenCount - lookup.descriptionTokens.length)
    const bestTokenDelta = bestMatch
      ? Math.abs(drugTokenCount - bestMatch.lookup.descriptionTokens.length)
      : Number.POSITIVE_INFINITY

    if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && tokenDelta < bestTokenDelta)) {
      bestMatch = { lookup, source: 'name', score }
    }
  }

  return bestMatch
}

const enrichDrugsWithNhisCatalog = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  rows: Record<string, unknown>[]
) => {
  if (rows.length === 0) {
    return rows
  }

  let nhisCatalogRows: Record<string, unknown>[] = []
  try {
    nhisCatalogRows = await loadNhisDrugCatalogRows(adminClient, organizationId)
  } catch (error) {
    console.error('tier-access NHIS catalog pricing warning:', error)
    return rows
  }

  const lookups = buildNhisCatalogLookups(nhisCatalogRows)
  if (lookups.length === 0) {
    return rows
  }

  const lookupsByCode = new Map(lookups.map((lookup) => [lookup.code, lookup]))

  return rows.map((row) => {
    const match = findBestNhisCatalogMatch(row, lookups, lookupsByCode)
    if (match) {
      const retailPrice = Number(row.price ?? 0)
      return {
        ...row,
        price: retailPrice > 0 ? row.price : match.lookup.unitPrice,
        nhis_code: match.lookup.code,
        nhis_price: match.lookup.unitPrice,
        nhis_unit: match.lookup.unit || normalizeText(row.nhis_unit) || null,
        is_nhis_listed: true,
        nhis_catalog_description: match.lookup.description,
        nhis_catalog_category: match.lookup.category || null,
        nhis_catalog_match_source: match.source,
      }
    }

    if (isDefaultMedicationBatchNumber(row.batch_number)) {
      return {
        ...row,
        nhis_code: null,
        nhis_price: null,
        nhis_unit: null,
        is_nhis_listed: false,
        nhis_catalog_description: null,
        nhis_catalog_category: null,
        nhis_catalog_match_source: null,
      }
    }

    return row
  })
}

const getDrugs = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  const branchId = await getBranchIdForInventoryRequest(adminClient, organizationId, requesterProfile, payload)
  const includeCatalog = Boolean(payload.includeCatalog)
  const searchTerm = normalizeText(payload.searchTerm)
  const inStockOnly = Boolean(payload.inStockOnly)
  const shouldMaintainCatalog = includeCatalog && !searchTerm && !inStockOnly

  if (shouldMaintainCatalog) {
    try {
      await syncDefaultMedicationCatalog(adminClient, organizationId, branchId)
    } catch (error) {
      // Never block core inventory visibility when catalog sync hits legacy-data issues.
      console.error('tier-access catalog sync warning:', error)
    }
  }

  const limit = clampPositiveInteger(payload.limit, 0, 100)
  const rows = []
  let from = 0
  let query = adminClient
    .from('drugs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'active')

  if (branchId) {
    query = query.eq('branch_id', branchId)
  }

  if (searchTerm) {
    const searchParts = [searchTerm, ...normalizeSearchTokens(searchTerm)]
      .map((part) => normalizeText(part).replace(/[%_,]/g, ''))
      .filter(Boolean)
      .flatMap((part) => [
        `name.ilike.%${part}%`,
        `batch_number.ilike.%${part}%`,
        `category.ilike.%${part}%`,
        `description.ilike.%${part}%`,
        `supplier.ilike.%${part}%`,
      ])

    query = query.or([...new Set(searchParts)].join(','))
  }

  if (inStockOnly) {
    query = query.gt('quantity', 0)
  }

  query = query.order('name').order('id')

  if (limit > 0) {
    const { data, error } = await query.limit(limit)

    if (error) {
      throw error
    }

    rows.push(...(data || []))
  } else {
    while (true) {
      const to = from + DRUGS_PER_PAGE - 1
      const { data, error } = await query.range(from, to)

      if (error) {
        throw error
      }

      rows.push(...(data || []))

      if (!data || data.length < DRUGS_PER_PAGE) {
        break
      }

      from += DRUGS_PER_PAGE
    }
  }

  const pricedRows = searchTerm || inStockOnly
    ? rows
    : await enrichDrugsWithNhisCatalog(adminClient, organizationId, rows)

  if (includeCatalog) {
    return pricedRows
  }

  return pricedRows.filter(
    (row) => !isDefaultMedicationBatchNumber(row.batch_number) || Number(row.quantity || 0) > 0
  )
}

const loadEpharmacyOrders = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  limit = 60
) => {
  const { data: orders, error } = await adminClient
    .from('epharmacy_orders')
    .select('*, epharmacy_order_items (*)')
    .or(`buyer_organization_id.eq.${organizationId},seller_organization_id.eq.${organizationId}`)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw error
  }

  const rows = orders || []
  const organizationIds = [
    ...new Set(
      rows
        .flatMap((order) => [normalizeText(order.buyer_organization_id), normalizeText(order.seller_organization_id)])
        .filter(Boolean)
    ),
  ]
  const branchIds = [
    ...new Set(
      rows
        .flatMap((order) => [normalizeText(order.buyer_branch_id), normalizeText(order.seller_branch_id)])
        .filter(Boolean)
    ),
  ]

  const [{ data: orgRows, error: orgError }, { data: branchRows, error: branchError }] = await Promise.all([
    organizationIds.length
      ? adminClient
          .from('organizations')
          .select('id, name, organization_type, license_number, epharmacy_certificate_number')
          .in('id', organizationIds)
      : Promise.resolve({ data: [], error: null }),
    branchIds.length
      ? adminClient
          .from('branches')
          .select('id, name, code')
          .in('id', branchIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (orgError) throw orgError
  if (branchError) throw branchError

  const orgMap = new Map((orgRows || []).map((org) => [normalizeText(org.id), org]))
  const branchMap = new Map((branchRows || []).map((branch) => [normalizeText(branch.id), branch]))

  return await Promise.all(rows.map(async (order) => {
    let prescriptionFileUrl = ''
    if (normalizeText(order.prescription_file_path)) {
      const { data } = await adminClient.storage
        .from('epharmacy-prescriptions')
        .createSignedUrl(normalizeText(order.prescription_file_path), 15 * 60)
      prescriptionFileUrl = data?.signedUrl || ''
    }

    return {
      ...order,
      prescription_file_url: prescriptionFileUrl,
      buyer_facility: orgMap.get(normalizeText(order.buyer_organization_id)) || null,
      seller_facility: orgMap.get(normalizeText(order.seller_organization_id)) || null,
      buyer_branch: branchMap.get(normalizeText(order.buyer_branch_id)) || null,
      seller_branch: branchMap.get(normalizeText(order.seller_branch_id)) || null,
    }
  }))
}

const getEpharmacyMarketplace = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireEpharmacyAccess(requesterProfile, 'Only pharmacy procurement or pharmacist staff can access e-pharmacy.')

  const searchTerm = normalizeText(payload.searchTerm)
  const facilityId = normalizeText(payload.facilityId)
  const today = new Date().toISOString().split('T')[0]
  const limit = clampPositiveInteger(payload.limit, 120, 250)

  const { data: currentFacility, error: currentFacilityError } = await adminClient
    .from('organizations')
    .select(EPHARMACY_ORG_SELECT_FIELDS)
    .eq('id', organizationId)
    .maybeSingle()

  if (currentFacilityError) throw currentFacilityError
  if (!currentFacility) throw new Error('Organization not found.')

  const { data: facilities, error: facilitiesError } = await adminClient
    .from('organizations')
    .select(EPHARMACY_ORG_SELECT_FIELDS)
    .eq('epharmacy_enabled', true)
    .eq('epharmacy_license_status', 'registered')
    .in('status', ['active', 'trial'])
    .order('name')

  if (facilitiesError) throw facilitiesError

  const facilityRows = facilities || []
  const facilityIds = facilityRows.map((facility) => normalizeText(facility.id)).filter(Boolean)
  const permittedFacilityIds = facilityId
    ? facilityIds.filter((id) => id === facilityId)
    : facilityIds

  let listingRows: Record<string, unknown>[] = []
  if (permittedFacilityIds.length > 0) {
    let listingsQuery = adminClient
      .from('drugs')
      .select(EPHARMACY_DRUG_SELECT_FIELDS)
      .in('organization_id', permittedFacilityIds)
      .eq('status', 'active')
      .eq('epharmacy_interfacility_visible', true)
      .gt('quantity', 0)
      .gte('expiry_date', today)
      .order('name')
      .limit(limit)

    if (searchTerm) {
      const searchParts = [searchTerm, ...normalizeSearchTokens(searchTerm)]
        .map((part) => normalizeText(part).replace(/[%_,]/g, ''))
        .filter(Boolean)
        .flatMap((part) => [
          `name.ilike.%${part}%`,
          `brand_name.ilike.%${part}%`,
          `generic_name.ilike.%${part}%`,
          `category.ilike.%${part}%`,
          `description.ilike.%${part}%`,
        ])

      listingsQuery = listingsQuery.or([...new Set(searchParts)].join(','))
    }

    const { data: listings, error: listingsError } = await listingsQuery
    if (listingsError) throw listingsError
    listingRows = (listings || []) as Record<string, unknown>[]
  }

  const facilityMap = new Map(facilityRows.map((facility) => [normalizeText(facility.id), facility]))
  const listings = listingRows
    .filter((row) => !isDefaultMedicationBatchNumber(row.batch_number) || Number(row.quantity || 0) > 0)
    .map((row) => {
      const saleClass = normalizeEpharmacySaleClass(row.epharmacy_sale_class || row.medicine_access_level)
      const availableQuantity = getEpharmacySurplusQuantity(row)
      return {
        ...row,
        sale_class: saleClass,
        available_quantity: availableQuantity,
        prescription_required: Boolean(row.epharmacy_requires_prescription) || EPHARMACY_REVIEW_SALE_CLASSES.has(saleClass),
        facility: facilityMap.get(normalizeText(row.organization_id)) || null,
        branch: row.branches || null,
      }
    })
    .filter((row) => row.facility && row.available_quantity > 0)
    .filter((row) => !BLOCKED_EPHARMACY_SALE_CLASSES.has(String(row.sale_class)))

  const { data: ownDrugs, error: ownDrugsError } = await adminClient
    .from('drugs')
    .select(EPHARMACY_DRUG_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('name')
    .limit(250)

  if (ownDrugsError) throw ownDrugsError

  const ownListings = (ownDrugs || [])
    .filter((row) => !isDefaultMedicationBatchNumber(row.batch_number) || Number(row.quantity || 0) > 0)
    .map((row) => {
      const saleClass = normalizeEpharmacySaleClass(row.epharmacy_sale_class || row.medicine_access_level)
      return {
        ...row,
        sale_class: saleClass,
        available_quantity: getEpharmacySurplusQuantity(row as Record<string, unknown>),
        prescription_required: Boolean(row.epharmacy_requires_prescription) || EPHARMACY_REVIEW_SALE_CLASSES.has(saleClass),
        branch: row.branches || null,
        blocked_online: BLOCKED_EPHARMACY_SALE_CLASSES.has(saleClass),
        expired_online: isExpiredDate(row.expiry_date),
      }
    })

  return {
    facility: currentFacility,
    facilities: facilityRows,
    listings,
    ownListings,
    orders: await loadEpharmacyOrders(adminClient, organizationId),
  }
}

const saveEpharmacyProfile = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireRole(
    requesterProfile,
    ['pharmacist', 'branch_manager'],
    'Only organization admins, pharmacists, or branch managers can update e-pharmacy registration.'
  )

  const profile = (payload.profile || {}) as Record<string, unknown>
  const enabled = Boolean(profile.enabled)
  const licenseNumber = normalizeText(profile.licenseNumber)
  const certificateNumber = normalizeText(profile.certificateNumber)
  const pharmacistName = normalizeText(profile.pharmacistInChargeName)
  const pharmacistRegNo = normalizeText(profile.pharmacistInChargeRegNo)

  if (enabled && (!licenseNumber || !certificateNumber || !pharmacistName || !pharmacistRegNo)) {
    throw new Error('License number, ePharmacy certificate, and pharmacist-in-charge details are required before publishing.')
  }

  const updatePayload = {
    license_number: licenseNumber || null,
    epharmacy_enabled: enabled,
    epharmacy_certificate_number: certificateNumber || null,
    epharmacy_license_status: enabled ? 'registered' : 'not_registered',
    pharmacist_in_charge_name: pharmacistName || null,
    pharmacist_in_charge_reg_no: pharmacistRegNo || null,
    epharmacy_contact_phone: normalizeText(profile.contactPhone) || null,
    epharmacy_contact_email: normalizeText(profile.contactEmail) || null,
    epharmacy_pickup_enabled: profile.pickupEnabled !== false,
    epharmacy_delivery_enabled: Boolean(profile.deliveryEnabled),
    epharmacy_delivery_zones: Array.isArray(profile.deliveryZones) ? profile.deliveryZones : [],
    epharmacy_minimum_order_amount: parseNonNegativeNumber(profile.minimumOrderAmount || 0, 'Minimum order amount'),
    epharmacy_terms_accepted_at: enabled ? new Date().toISOString() : null,
    epharmacy_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await adminClient
    .from('organizations')
    .update(updatePayload)
    .eq('id', organizationId)
    .select(EPHARMACY_ORG_SELECT_FIELDS)
    .single()

  if (error) throw error
  await tryWriteTierAuditEvent(adminClient, requesterProfile, organizationId, {
    eventType: 'epharmacy.profile.updated',
    entityType: 'organizations',
    entityId: organizationId,
    action: enabled ? 'enable_epharmacy' : 'disable_epharmacy',
    details: {
      epharmacy_enabled: enabled,
      license_number: licenseNumber || null,
      epharmacy_certificate_number: certificateNumber || null,
    },
  })
  return { facility: data }
}

const updateEpharmacyListingControls = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireInventoryAccess(requesterProfile, 'Only inventory staff can publish e-pharmacy stock.')

  const drugId = assertRequiredText(payload.drugId, 'Drug id')
  const controls = (payload.controls || {}) as Record<string, unknown>
  const saleClass = normalizeEpharmacySaleClass(controls.saleClass)
  const interfacilityVisible = Boolean(controls.interfacilityVisible)
  const customerVisible = Boolean(controls.customerVisible)
  const visible = interfacilityVisible || customerVisible || Boolean(controls.visible)

  if (visible && BLOCKED_EPHARMACY_SALE_CLASSES.has(saleClass)) {
    throw new Error('Restricted, controlled, and narcotic medicines cannot be published for online ordering.')
  }

  const { data: existingDrug, error: existingDrugError } = await adminClient
    .from('drugs')
    .select('id, organization_id')
    .eq('id', drugId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (existingDrugError) throw existingDrugError
  if (!existingDrug) throw new Error('Medicine not found.')

  const updatePayload = {
    epharmacy_visible: visible,
    epharmacy_interfacility_visible: interfacilityVisible,
    epharmacy_customer_visible: customerVisible,
    epharmacy_sale_class: saleClass,
    epharmacy_requires_prescription: Boolean(controls.requiresPrescription) || EPHARMACY_REVIEW_SALE_CLASSES.has(saleClass),
    epharmacy_pickup_enabled: controls.pickupEnabled !== false,
    epharmacy_delivery_enabled: Boolean(controls.deliveryEnabled),
    epharmacy_warning: normalizeText(controls.warning) || null,
    epharmacy_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await adminClient
    .from('drugs')
    .update(updatePayload)
    .eq('id', drugId)
    .eq('organization_id', organizationId)
    .select(EPHARMACY_DRUG_SELECT_FIELDS)
    .single()

  if (error) throw error
  await tryWriteTierAuditEvent(adminClient, requesterProfile, organizationId, {
    eventType: 'epharmacy.listing.updated',
    entityType: 'drugs',
    entityId: drugId,
    action: 'update_epharmacy_listing_controls',
    details: {
      sale_class: saleClass,
      interfacility_visible: interfacilityVisible,
      customer_visible: customerVisible,
    },
  })
  return { listing: data }
}

const getBuyerBranchIdForEpharmacyOrder = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  const requestedBranchId = normalizeText(payload.buyerBranchId) || requesterProfile.branch_id
  if (!requestedBranchId) return null

  const { data, error } = await adminClient
    .from('branches')
    .select('id')
    .eq('id', requestedBranchId)
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('Buyer branch could not be found.')
  return requestedBranchId
}

const createEpharmacyOrder = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireEpharmacyAccess(requesterProfile, 'Only pharmacy procurement or pharmacist staff can request medicines.')

  const orderInput = (payload.order || {}) as Record<string, unknown>
  const sellerOrganizationId = assertRequiredText(orderInput.sellerOrganizationId, 'Seller facility')
  if (sellerOrganizationId === organizationId) {
    throw new Error('Select a colleague facility before creating an e-pharmacy order.')
  }

  const itemsInput = Array.isArray(orderInput.items) ? orderInput.items : []
  if (itemsInput.length === 0) {
    throw new Error('Add at least one medicine to the e-pharmacy order.')
  }

  const { data: sellerFacility, error: sellerFacilityError } = await adminClient
    .from('organizations')
    .select(EPHARMACY_ORG_SELECT_FIELDS)
    .eq('id', sellerOrganizationId)
    .eq('epharmacy_enabled', true)
    .eq('epharmacy_license_status', 'registered')
    .maybeSingle()

  if (sellerFacilityError) throw sellerFacilityError
  if (!sellerFacility) throw new Error('Seller facility is not registered for e-pharmacy ordering.')

  const fulfillmentMethod = normalizeEpharmacyFulfillmentMethod(orderInput.fulfillmentMethod)
  if (fulfillmentMethod === 'pickup' && sellerFacility.epharmacy_pickup_enabled === false) {
    throw new Error('This seller facility is not accepting pickup orders.')
  }
  if (fulfillmentMethod === 'delivery' && !sellerFacility.epharmacy_delivery_enabled) {
    throw new Error('This seller facility is not accepting delivery orders yet.')
  }

  const requestedItems = itemsInput.map((item) => item as Record<string, unknown>)
  const requestedDrugIds = [...new Set(requestedItems.map((item) => assertRequiredText(item.drugId, 'Medicine')).filter(Boolean))]
  const { data: drugRows, error: drugRowsError } = await adminClient
    .from('drugs')
    .select(EPHARMACY_DRUG_SELECT_FIELDS)
    .eq('organization_id', sellerOrganizationId)
    .eq('status', 'active')
    .in('id', requestedDrugIds)

  if (drugRowsError) throw drugRowsError

  const drugMap = new Map((drugRows || []).map((drug) => [normalizeText(drug.id), drug]))
  const orderItems = requestedItems.map((item) => {
    const drugId = assertRequiredText(item.drugId, 'Medicine')
    const drug = drugMap.get(drugId) as Record<string, unknown> | undefined
    if (!drug) throw new Error('One of the selected medicines is no longer available.')

    const saleClass = normalizeEpharmacySaleClass(drug.epharmacy_sale_class || drug.medicine_access_level)
    if (BLOCKED_EPHARMACY_SALE_CLASSES.has(saleClass)) {
      throw new Error(`${normalizeText(drug.name) || 'This medicine'} cannot be ordered through e-pharmacy.`)
    }
    if (!drug.epharmacy_interfacility_visible) {
      throw new Error(`${normalizeText(drug.name) || 'This medicine'} is not published for inter-facility ordering.`)
    }
    if (isExpiredDate(drug.expiry_date)) {
      throw new Error(`${normalizeText(drug.name) || 'This medicine'} is expired or missing a valid expiry date.`)
    }

    const quantity = parseNonNegativeNumber(item.quantity, 'Order quantity')
    if (quantity <= 0) throw new Error('Order quantity must be greater than zero.')

    const availableQuantity = getEpharmacySurplusQuantity(drug)
    if (quantity > availableQuantity) {
      throw new Error(`${normalizeText(drug.name) || 'This medicine'} has only ${availableQuantity} surplus unit(s) available.`)
    }

    const unitPrice = Number(drug.price || 0)
    return {
      drug,
      row: {
        drug_id: drugId,
        seller_organization_id: sellerOrganizationId,
        buyer_organization_id: organizationId,
        drug_name: assertRequiredText(drug.name, 'Medicine name'),
        brand_name: normalizeText(drug.brand_name) || null,
        generic_name: normalizeText(drug.generic_name) || null,
        batch_number: normalizeText(drug.batch_number) || null,
        expiry_date: normalizeText(drug.expiry_date) || null,
        quantity,
        unit: normalizeText(drug.unit) || 'unit',
        unit_price: unitPrice,
        total_amount: quantity * unitPrice,
        sale_class: saleClass,
        prescription_required: Boolean(drug.epharmacy_requires_prescription) || EPHARMACY_REVIEW_SALE_CLASSES.has(saleClass),
      },
    }
  })

  const totalAmount = orderItems.reduce((sum, item) => sum + Number(item.row.total_amount || 0), 0)
  const minimumOrder = Number(sellerFacility.epharmacy_minimum_order_amount || 0)
  if (minimumOrder > 0 && totalAmount < minimumOrder) {
    throw new Error(`Minimum order amount for this seller is GHS ${minimumOrder.toFixed(2)}.`)
  }

  const sellerBranchId =
    normalizeText(orderInput.sellerBranchId) ||
    normalizeText(orderItems.find((item) => normalizeText(item.drug.branch_id))?.drug.branch_id)
  const buyerBranchId = await getBuyerBranchIdForEpharmacyOrder(
    adminClient,
    organizationId,
    requesterProfile,
    orderInput
  )
  const orderNumber = buildEpharmacyOrderNumber()
  const prescriptionRequired = orderItems.some((item) => item.row.prescription_required)

  const { data: order, error: orderError } = await adminClient
    .from('epharmacy_orders')
    .insert([{
      order_number: orderNumber,
      channel: 'interfacility',
      buyer_organization_id: organizationId,
      buyer_branch_id: buyerBranchId,
      seller_organization_id: sellerOrganizationId,
      seller_branch_id: sellerBranchId || null,
      prescription_required: prescriptionRequired,
      status: 'pending_review',
      fulfillment_method: fulfillmentMethod,
      payment_method: normalizeEpharmacyPaymentMethod(orderInput.paymentMethod),
      payment_status: 'pending',
      total_amount: totalAmount,
      notes: normalizeText(orderInput.notes) || null,
      requested_by: requesterProfile.id,
    }])
    .select('*')
    .single()

  if (orderError) throw orderError

  const { error: itemsError } = await adminClient.from('epharmacy_order_items').insert(
    orderItems.map((item) => ({
      order_id: order.id,
      ...item.row,
    }))
  )

  if (itemsError) throw itemsError
  await tryWriteTierAuditEvent(adminClient, requesterProfile, organizationId, {
    eventType: 'epharmacy.order.created',
    entityType: 'epharmacy_orders',
    entityId: order.id,
    action: 'create',
    details: {
      order_number: order.order_number,
      seller_organization_id: sellerOrganizationId,
      item_count: orderItems.length,
      total_amount: totalAmount,
      prescription_required: prescriptionRequired,
    },
  })

  return {
    order,
    orders: await loadEpharmacyOrders(adminClient, organizationId),
  }
}

const getEpharmacyStatusTimestamp = (status: string) => {
  if (status === 'paid') return { payment_status: 'paid', paid_at: new Date().toISOString() }
  if (status === 'packed') return { packed_at: new Date().toISOString() }
  if (status === 'out_for_delivery') return { dispatched_at: new Date().toISOString() }
  if (status === 'delivered') return { delivered_at: new Date().toISOString() }
  return {}
}

const assertEpharmacyTransitionAllowed = (
  order: Record<string, unknown>,
  nextStatus: string,
  isSeller: boolean,
  isBuyer: boolean
) => {
  const currentStatus = normalizeText(order.status)
  const allowed: Record<string, string[]> = {
    pending_review: ['approved', 'rejected', 'cancelled'],
    approved: ['paid', 'cancelled'],
    paid: ['packed', 'cancelled'],
    packed: ['out_for_delivery', 'delivered'],
    out_for_delivery: ['delivered'],
  }

  if (!allowed[currentStatus]?.includes(nextStatus)) {
    throw new Error(`Order cannot move from ${currentStatus || 'unknown'} to ${nextStatus}.`)
  }

  if (nextStatus === 'cancelled') {
    if (!isBuyer && !isSeller) throw new Error('Only the buyer or seller facility can cancel this order.')
    return
  }

  if (!isSeller && nextStatus !== 'paid') {
    throw new Error('Only the seller facility can update this order status.')
  }

  if (nextStatus === 'paid' && !isSeller && !isBuyer) {
    throw new Error('Only the buyer or seller facility can mark this order paid.')
  }
}

const updateEpharmacyOrderStatus = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireEpharmacyAccess(requesterProfile, 'Only pharmacy procurement or pharmacist staff can update e-pharmacy orders.')

  const orderId = assertRequiredText(payload.orderId, 'Order id')
  const nextStatus = normalizeEpharmacyStatus(payload.status)
  const note = normalizeText(payload.note)
  const rejectionReason = normalizeText(payload.rejectionReason)

  const { data: order, error: orderError } = await adminClient
    .from('epharmacy_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) throw orderError
  if (!order) throw new Error('E-pharmacy order not found.')

  const isSeller = normalizeText(order.seller_organization_id) === organizationId
  const isBuyer = normalizeText(order.buyer_organization_id) === organizationId
  if (!isSeller && !isBuyer) {
    throw new Error('This order does not belong to your facility.')
  }

  assertEpharmacyTransitionAllowed(order, nextStatus, isSeller, isBuyer)

  if (['approved', 'rejected'].includes(nextStatus)) {
    requireRole(requesterProfile, EPHARMACY_REVIEW_ROLES, 'Only an admin or pharmacist can review e-pharmacy orders.')
  }

  if (nextStatus === 'rejected' && !rejectionReason) {
    throw new Error('Rejection reason is required.')
  }

  if (nextStatus === 'delivered') {
    const completionFunction = order.channel === 'customer'
      ? 'complete_customer_epharmacy_order'
      : 'complete_epharmacy_order'
    const { data, error } = await adminClient.rpc(completionFunction, {
      p_order_id: orderId,
      p_actor_user_id: requesterProfile.id,
      p_actor_organization_id: organizationId,
    })

    if (error) throw error
    if (data?.error) throw new Error(String(data.error))
    await tryWriteTierAuditEvent(adminClient, requesterProfile, organizationId, {
      eventType: 'epharmacy.order.delivered',
      entityType: 'epharmacy_orders',
      entityId: orderId,
      action: 'deliver',
      details: {
        completion: data,
      },
    })
    return {
      completion: data,
      orders: await loadEpharmacyOrders(adminClient, organizationId),
    }
  }

  const updatePayload: Record<string, unknown> = {
    status: nextStatus,
    updated_at: new Date().toISOString(),
    pharmacist_note: note || order.pharmacist_note || null,
    ...getEpharmacyStatusTimestamp(nextStatus),
  }

  if (nextStatus === 'approved') {
    updatePayload.reviewed_by = requesterProfile.id
    updatePayload.reviewed_at = new Date().toISOString()
  }

  if (nextStatus === 'rejected') {
    updatePayload.reviewed_by = requesterProfile.id
    updatePayload.reviewed_at = new Date().toISOString()
    updatePayload.rejection_reason = rejectionReason
  }

  if (nextStatus === 'cancelled') {
    updatePayload.rejection_reason = note || 'Order cancelled'
  }

  const { data: updatedOrder, error: updateError } = await adminClient
    .from('epharmacy_orders')
    .update(updatePayload)
    .eq('id', orderId)
    .select('*')
    .single()

  if (updateError) throw updateError
  await tryWriteTierAuditEvent(adminClient, requesterProfile, organizationId, {
    eventType: 'epharmacy.order.status_updated',
    entityType: 'epharmacy_orders',
    entityId: orderId,
    action: nextStatus,
    details: {
      previous_status: order.status,
      next_status: nextStatus,
      note,
      rejection_reason: rejectionReason || null,
    },
  })

  return {
    order: updatedOrder,
    orders: await loadEpharmacyOrders(adminClient, organizationId),
  }
}

const assertCanAddDrugs = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId: string | null,
  additionalCount: number
) => {
  const tierContext = await getOrganizationTierContext(adminClient, organizationId)
  if (tierContext.isSuspended) {
    throw new Error('This pharmacy is locked. Contact platform support to restore access.')
  }

  const maxDrugs = tierContext.tierLimits.maxDrugs
  if (!Number.isFinite(maxDrugs)) {
    return
  }

  const currentCount = await getDrugCount(adminClient, organizationId, branchId)
  if (currentCount + additionalCount > maxDrugs) {
    throw new Error(
      `This organization has reached the ${maxDrugs}-drug limit for its ${tierContext.effectiveTier === 'pro' ? 'Professional' : 'Basic'} plan.`
    )
  }
}

const assertCustomBatchNumberAllowed = (batchNumber: string | null | undefined) => {
  if (!normalizeText(batchNumber)) {
    return
  }

  if (isDefaultMedicationBatchNumber(batchNumber)) {
    throw new Error(DEFAULT_CATALOG_BATCH_ERROR)
  }
}

// ✅ NHIS PHARMACY LEVEL PATCH START
const normalizePharmacyLevelForSave = (value: unknown) => {
  const normalized = normalizeText(value).toUpperCase()
  return VALID_PHARMACY_LEVELS.includes(normalized) ? normalized : null
}

const normalizeMedicineAccessLevelForSave = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase()
  return VALID_MEDICINE_ACCESS_LEVELS.find((level) => level.toLowerCase() === normalized) || null
}
// ✅ NHIS PHARMACY LEVEL PATCH END

const buildDrugCreatePayload = (
  organizationId: string,
  branchId: string | null,
  drugData: Record<string, unknown>,
  batchNumber: string | null
) => ({
  organization_id: organizationId,
  branch_id: branchId,
  name: assertRequiredText(drugData.name, 'Drug name'),
  batch_number: batchNumber,
  expiry_date: assertRequiredText(drugData.expiryDate, 'Expiry date'),
  quantity: parseNonNegativeNumber(drugData.quantity, 'Quantity'),
  price: parseNonNegativeNumber(drugData.price, 'Price'),
  cost_price: parseNonNegativeNumber(drugData.costPrice ?? 0, 'Cost price'),
  nhis_code: normalizeText(drugData.nhisCode) || null,
  nhis_price: drugData.nhisPrice === undefined || drugData.nhisPrice === null || normalizeText(drugData.nhisPrice) === ''
    ? null
    : parseNonNegativeNumber(drugData.nhisPrice, 'NHIS price'),
  nhis_unit: normalizeText(drugData.nhisUnit) || null,
  is_nhis_listed: Boolean(drugData.isNhisListed),
  // ✅ NHIS PHARMACY LEVEL PATCH START
  medicine_access_level: normalizeMedicineAccessLevelForSave(drugData.medicineAccessLevel),
  required_pharmacy_level: normalizePharmacyLevelForSave(drugData.requiredPharmacyLevel),
  // ✅ NHIS PHARMACY LEVEL PATCH END
  supplier: normalizeText(drugData.supplier) || null,
  category: normalizeText(drugData.category) || null,
  description: normalizeText(drugData.description) || null,
  reorder_level: parseNonNegativeNumber(drugData.reorderLevel ?? 10, 'Reorder level'),
  unit: normalizeText(drugData.unit) || 'tablet',
  sale_on_return: Boolean(drugData.saleOnReturn),
})

const findDrugByIdentity = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId: string | null,
  name: string,
  batchNumber: string | null
) => {
  let query = adminClient
    .from('drugs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('name', name)
  query = batchNumber ? query.eq('batch_number', batchNumber) : query.is('batch_number', null)

  query = branchId ? query.eq('branch_id', branchId) : query.is('branch_id', null)

  const { data, error } = await query.order('updated_at', { ascending: false }).limit(1)

  if (error) {
    throw error
  }

  return data?.[0] || null
}

const findActiveDrugByNhisCode = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId: string | null,
  nhisCode: string
) => {
  let query = adminClient
    .from('drugs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('nhis_code', nhisCode)
    .eq('status', 'active')

  query = branchId ? query.eq('branch_id', branchId) : query.is('branch_id', null)

  const { data, error } = await query
    .order('quantity', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) {
    throw error
  }

  return data?.[0] || null
}

const findActiveDrugByName = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId: string | null,
  name: string
) => {
  let query = adminClient
    .from('drugs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('name', name)
    .eq('status', 'active')

  query = branchId ? query.eq('branch_id', branchId) : query.is('branch_id', null)

  const { data, error } = await query
    .order('quantity', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) {
    throw error
  }

  return data?.[0] || null
}

const saveDrugForOrganization = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId: string | null,
  drugPayload: Record<string, unknown>
) => {
  const name = assertRequiredText(drugPayload.name, 'Drug name')
  const batchNumber = normalizeText(drugPayload.batch_number) || null
  const existingDrug = await findDrugByIdentity(adminClient, organizationId, branchId, name, batchNumber)
  const action = getExistingDrugSaveAction(existingDrug)

  if (action === 'reactivate' || action === 'update_existing') {
    const { data, error } = await adminClient
      .from('drugs')
      .update({
        ...drugPayload,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingDrug?.id)
      .eq('organization_id', organizationId)
      .select()
      .single()

    if (error) {
      throw error
    }

    return {
      action,
      drug: data,
    }
  }

  await assertCanAddDrugs(adminClient, organizationId, branchId, 1)

  const { data, error } = await adminClient
    .from('drugs')
    .insert([
      {
        ...drugPayload,
        status: 'active',
      },
    ])
    .select()
    .single()

  if (error) {
    throw error
  }

  return {
    action,
    drug: data,
  }
}

const getDrugForOrganization = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  drugId: string
) => {
  const { data, error } = await adminClient
    .from('drugs')
    .select('*')
    .eq('id', drugId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error('Drug not found.')
  }

  return data
}

const generateClaimNumber = async (adminClient: ReturnType<typeof createAdminClient>) => {
  const { data, error } = await adminClient.rpc('generate_claim_number')
  if (error || !normalizeText(data)) {
    const timestamp = Date.now()
    return `CLM-${timestamp.toString().slice(-8)}`
  }

  return String(data)
}

const getClaims = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  const filters = (payload.filters || {}) as Record<string, unknown>

  let query = adminClient
    .from('claims')
    .select(CLAIM_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .order('submitted_at', { ascending: false })

  const status = normalizeText(filters.status)
  const insuranceProvider = normalizeText(filters.insuranceProvider)
  const searchTerm = normalizeText(filters.searchTerm)
  const claimId = normalizeText(filters.id)
  const branchId = normalizeText(filters.branchId)
  const limit = parsePositiveInteger(filters.limit, 0)

  if (claimId) {
    query = query.eq('id', claimId)
  }

  if (status) {
    query = query.eq('claim_status', status)
  }

  if (insuranceProvider) {
    query = query.eq('insurance_provider', insuranceProvider)
  }

  if (branchId) {
    query = query.eq('branch_id', branchId)
  }

  if (filters.startDate) {
    query = query.gte('service_date', String(filters.startDate))
  }

  if (filters.endDate) {
    query = query.lte('service_date', String(filters.endDate))
  }

  if (limit > 0 && !searchTerm) {
    query = query.limit(limit)
  }

  const { data, error } = await query
  if (error) {
    throw error
  }

  const rows = data || []
  if (!searchTerm) {
    return rows
  }

  const term = searchTerm.toLowerCase()
  const filteredRows = rows.filter((claim) => {
    const patient = claim.patients as Record<string, unknown> | null
    return [
      claim.patient_name,
      claim.claim_number,
      claim.insurance_provider,
      claim.insurance_id,
      patient?.phone,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term))
  })

  return limit > 0 ? filteredRows.slice(0, limit) : filteredRows
}

const getClaimsStatistics = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const { data, error } = await adminClient
    .from('claims')
    .select('claim_status, total_amount')
    .eq('organization_id', organizationId)

  if (error) {
    throw error
  }

  const rows = data || []

  return {
    total: rows.length,
    pending: rows.filter((row) => row.claim_status === 'pending').length,
    approved: rows.filter((row) => row.claim_status === 'approved').length,
    rejected: rows.filter((row) => row.claim_status === 'rejected').length,
    processing: rows.filter((row) => row.claim_status === 'processing').length,
    totalAmount: rows.reduce((sum, row) => sum + Number.parseFloat(String(row.total_amount || 0)), 0),
    approvedAmount: rows
      .filter((row) => row.claim_status === 'approved')
      .reduce((sum, row) => sum + Number.parseFloat(String(row.total_amount || 0)), 0),
  }
}

const getClaimsStatisticsFromRows = (rows: Record<string, unknown>[]) => ({
  total: rows.length,
  pending: rows.filter((row) => row.claim_status === 'pending').length,
  approved: rows.filter((row) => row.claim_status === 'approved').length,
  rejected: rows.filter((row) => row.claim_status === 'rejected').length,
  processing: rows.filter((row) => row.claim_status === 'processing').length,
  totalAmount: rows.reduce(
    (sum, row) => sum + Number.parseFloat(String(row.total_amount || 0)),
    0
  ),
  approvedAmount: rows
    .filter((row) => row.claim_status === 'approved')
    .reduce(
      (sum, row) => sum + Number.parseFloat(String(row.total_amount || 0)),
      0
    ),
})

const sanitizePostgrestSearchTerm = (value: unknown) =>
  normalizeText(value)
    .replace(/[%_,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const getPatientVisitRows = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  patientIds: string[] = []
) => {
  const scopedPatientIds = patientIds.map(normalizeText).filter(Boolean)
  if (patientIds.length > 0 && scopedPatientIds.length === 0) return []

  const rows: Record<string, unknown>[] = []
  const pageSize = 1000
  let from = 0

  while (true) {
    let query = adminClient
      .from('sales')
      .select('patient_id, sale_date')
      .eq('organization_id', organizationId)
      .not('patient_id', 'is', null)
      .order('id')

    if (scopedPatientIds.length > 0) {
      query = query.in('patient_id', scopedPatientIds)
    }

    const { data, error } = await query
      .range(from, from + pageSize - 1)

    if (error) throw error

    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
    from += pageSize
  }

  return rows
}

const getPatientWorkspaceData = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  {
    includeVisitStats = true,
    page,
    pageSize,
    searchTerm,
  }: {
    includeVisitStats?: boolean
    page?: unknown
    pageSize?: unknown
    searchTerm?: unknown
  } = {}
) => {
  const hasPaging = page !== undefined || pageSize !== undefined || searchTerm !== undefined
  const pageNumber = parsePositiveInteger(page, 1)
  const resolvedPageSize = hasPaging
    ? clampPositiveInteger(pageSize, PATIENT_WORKSPACE_DEFAULT_PAGE_SIZE, PATIENT_WORKSPACE_MAX_PAGE_SIZE)
    : PATIENT_WORKSPACE_MAX_PATIENTS
  const from = (pageNumber - 1) * resolvedPageSize
  const to = from + resolvedPageSize - 1
  const term = sanitizePostgrestSearchTerm(searchTerm)
  const likeTerm = term ? `%${term}%` : ''

  let patientsQuery = adminClient
    .from('patients')
    .select(PATIENT_WORKSPACE_PATIENT_SELECT_FIELDS, hasPaging ? { count: 'exact' } : undefined)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })

  if (term) {
    patientsQuery = patientsQuery.or([
      `full_name.ilike.${likeTerm}`,
      `phone.ilike.${likeTerm}`,
      `email.ilike.${likeTerm}`,
      `insurance_provider.ilike.${likeTerm}`,
      `insurance_id.ilike.${likeTerm}`,
    ].join(','))
  }

  patientsQuery = hasPaging
    ? patientsQuery.range(from, to)
    : patientsQuery.limit(PATIENT_WORKSPACE_MAX_PATIENTS)

  let nhisClaimsQuery = adminClient
    .from('nhis_claims')
    .select(PATIENT_WORKSPACE_NHIS_CLAIM_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })

  if (term) {
    nhisClaimsQuery = nhisClaimsQuery.or([
      `surname.ilike.${likeTerm}`,
      `other_names.ilike.${likeTerm}`,
      `member_no.ilike.${likeTerm}`,
      `hin.ilike.${likeTerm}`,
      `claim_number.ilike.${likeTerm}`,
      `folder_no.ilike.${likeTerm}`,
    ].join(','))
  }

  nhisClaimsQuery = hasPaging
    ? nhisClaimsQuery.range(from, to)
    : nhisClaimsQuery.limit(PATIENT_WORKSPACE_MAX_NHIS_CLAIMS)

  const [
    { data: patients, error: patientsError, count: patientsCount },
    { data: nhisClaims, error: nhisClaimsError },
  ] = await Promise.all([
    patientsQuery,
    nhisClaimsQuery,
  ])

  if (patientsError) throw patientsError
  if (nhisClaimsError) throw nhisClaimsError

  const visitRows = includeVisitStats
    ? await getPatientVisitRows(
      adminClient,
      organizationId,
      hasPaging ? (patients || []).map((patient) => normalizeText(patient.id)) : []
    )
    : []

  const visitStats = visitRows.reduce<Record<string, { visits: number; lastVisit: string | null }>>(
    (stats, row) => {
      const patientId = normalizeText(row.patient_id)
      if (!patientId) return stats

      const current = stats[patientId] || { visits: 0, lastVisit: null }
      const saleDate = normalizeText(row.sale_date)
      stats[patientId] = {
        visits: current.visits + 1,
        lastVisit:
          saleDate && (!current.lastVisit || saleDate > current.lastVisit)
            ? saleDate
            : current.lastVisit,
      }
      return stats
    },
    {}
  )

  return {
    patients: patients || [],
    nhisClaims: nhisClaims || [],
    visitStats,
    total: hasPaging ? Number(patientsCount || 0) : undefined,
    page: hasPaging ? pageNumber : undefined,
    pageSize: hasPaging ? resolvedPageSize : undefined,
  }
}

const createClaim = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireClaimCreateAccess(requesterProfile, 'Only sales or claims staff can create claims.')

  const claimData = (payload.claimData || {}) as Record<string, unknown>
  const itemsInput = Array.isArray(claimData.items) ? claimData.items : []
  if (itemsInput.length === 0) {
    throw new Error('At least one claim item is required.')
  }

  const patientName = assertRequiredText(claimData.patientName, 'Patient name')
  const insuranceProvider = assertRequiredText(claimData.insuranceProvider, 'Insurance provider')
  const insuranceId = assertRequiredText(claimData.insuranceId, 'Insurance ID')

  const items = itemsInput.map((item) => {
    const row = item as Record<string, unknown>
    const quantity = parseNonNegativeNumber(row.quantity, 'Item quantity')
    const price = parseNonNegativeNumber(row.price, 'Item price')

    return {
      drug_id: normalizeText(row.drugId) || null,
      drug_name: assertRequiredText(row.name, 'Drug name'),
      quantity,
      unit_price: price,
      total_price: quantity * price,
    }
  })

  const totalAmount = items.reduce((sum, item) => sum + item.total_price, 0)
  const claimNumber = await generateClaimNumber(adminClient)
  const submittedAt = new Date().toISOString()
  const branchId = await getBranchIdForInventoryRequest(adminClient, organizationId, requesterProfile, {
    branchId: normalizeText(claimData.branchId),
  })

  const { data: insertedClaim, error: claimError } = await adminClient
    .from('claims')
    .insert([
      {
        organization_id: organizationId,
        claim_number: claimNumber,
        patient_id: normalizeText(claimData.patientId) || null,
        patient_name: patientName,
        insurance_provider: insuranceProvider,
        insurance_id: insuranceId,
        branch_id: branchId,
        service_date: normalizeNhiaServiceDate(claimData.serviceDate) || toNhisCalendarDate(),
        total_amount: totalAmount,
        claim_status: 'pending',
        prescription_url: normalizeText(claimData.prescriptionUrl) || null,
        notes: normalizeText(claimData.notes) || null,
        submitted_by: requesterProfile.id,
        submitted_at: submittedAt,
      },
    ])
    .select('id, claim_number')
    .single()

  if (claimError) {
    throw claimError
  }

  const { error: itemsError } = await adminClient.from('claim_items').insert(
    items.map((item) => ({
      organization_id: organizationId,
      claim_id: insertedClaim.id,
      ...item,
    }))
  )

  if (itemsError) {
    throw itemsError
  }

  return {
    claim: insertedClaim,
    claimNumber: insertedClaim.claim_number,
  }
}

const buildClaimItems = (itemsInput: unknown[]) =>
  itemsInput.map((item) => {
    const row = item as Record<string, unknown>
    const quantity = parseNonNegativeNumber(row.quantity, 'Item quantity')
    const price = parseNonNegativeNumber(row.price, 'Item price')

    return {
      drug_id: normalizeText(row.drugId) || null,
      drug_name: assertRequiredText(row.name, 'Drug name'),
      quantity,
      unit_price: price,
      total_price: quantity * price,
    }
  })

const updateClaim = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  claimId: string,
  payload: Record<string, unknown>
) => {
  requireClaimsAccess(requesterProfile, 'Only claims staff can edit claims.')

  const claimData = (payload.claimData || {}) as Record<string, unknown>
  const itemsInput = Array.isArray(claimData.items) ? claimData.items : []
  if (itemsInput.length === 0) {
    throw new Error('At least one claim item is required.')
  }

  const { data: existingClaim, error: existingClaimError } = await adminClient
    .from('claims')
    .select('id, claim_number, claim_status')
    .eq('id', claimId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (existingClaimError) {
    throw existingClaimError
  }

  if (!existingClaim) {
    throw new Error('Claim not found.')
  }

  if (existingClaim.claim_status !== 'pending') {
    throw new Error('Only pending claims can be edited before approval.')
  }

  const patientName = assertRequiredText(claimData.patientName, 'Patient name')
  const insuranceProvider = assertRequiredText(claimData.insuranceProvider, 'Insurance provider')
  const insuranceId = assertRequiredText(claimData.insuranceId, 'Insurance ID')
  const items = buildClaimItems(itemsInput)
  const totalAmount = items.reduce((sum, item) => sum + item.total_price, 0)
  const branchId = await getBranchIdForInventoryRequest(adminClient, organizationId, requesterProfile, {
    branchId: normalizeText(claimData.branchId),
  })

  const updatePayload = {
    patient_id: normalizeText(claimData.patientId) || null,
    patient_name: patientName,
    insurance_provider: insuranceProvider,
    insurance_id: insuranceId,
    branch_id: branchId,
    service_date: normalizeNhiaServiceDate(claimData.serviceDate) || toNhisCalendarDate(),
    total_amount: totalAmount,
    prescription_url: normalizeText(claimData.prescriptionUrl) || null,
    notes: normalizeText(claimData.notes) || null,
    updated_at: new Date().toISOString(),
  }

  const { error: claimError } = await adminClient
    .from('claims')
    .update(updatePayload)
    .eq('id', claimId)
    .eq('organization_id', organizationId)

  if (claimError) {
    throw claimError
  }

  const { error: deleteItemsError } = await adminClient
    .from('claim_items')
    .delete()
    .eq('claim_id', claimId)
    .eq('organization_id', organizationId)

  if (deleteItemsError) {
    throw deleteItemsError
  }

  const { error: itemsError } = await adminClient.from('claim_items').insert(
    items.map((item) => ({
      organization_id: organizationId,
      claim_id: claimId,
      ...item,
    }))
  )

  if (itemsError) {
    throw itemsError
  }

  const { data: updatedClaim, error: fetchError } = await adminClient
    .from('claims')
    .select(CLAIM_SELECT_FIELDS)
    .eq('id', claimId)
    .eq('organization_id', organizationId)
    .single()

  if (fetchError) {
    throw fetchError
  }

  return {
    claim: updatedClaim,
    claimNumber: updatedClaim.claim_number,
  }
}

const updateClaimStatus = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  claimId: string,
  nextStatus: 'approved' | 'rejected',
  payload: Record<string, unknown>
) => {
  requireClaimsAccess(requesterProfile, 'Only claims staff can update claim status.')

  const { data: existingClaim, error: existingClaimError } = await adminClient
    .from('claims')
    .select('id')
    .eq('id', claimId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (existingClaimError) {
    throw existingClaimError
  }

  if (!existingClaim) {
    throw new Error('Claim not found.')
  }

  const updatePayload: Record<string, string | number> = {
    claim_status: nextStatus,
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  if (nextStatus === 'approved') {
    updatePayload.approval_amount = parseNonNegativeNumber(payload.approvalAmount, 'Approval amount')
  }

  if (nextStatus === 'rejected') {
    updatePayload.rejection_reason = assertRequiredText(payload.rejectionReason, 'Rejection reason')
  }

  const { data, error } = await adminClient
    .from('claims')
    .update(updatePayload)
    .eq('id', claimId)
    .eq('organization_id', organizationId)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

const createDrug = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireStockAdjustmentAccess(requesterProfile, 'You do not have permission to adjust inventory stock.')

  const drugData = (payload.drug || {}) as Record<string, unknown>
  const batchNumber = normalizeText(drugData.batchNumber) || null
  assertCustomBatchNumberAllowed(batchNumber)
  const branchId = await getBranchIdForInventoryRequest(adminClient, organizationId, requesterProfile, {
    branchId: normalizeText(drugData.branchId),
  })
  const drugPayload = buildDrugCreatePayload(organizationId, branchId, drugData, batchNumber)
  return await saveDrugForOrganization(adminClient, organizationId, branchId, drugPayload)
}

const updateDrug = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireStockAdjustmentAccess(requesterProfile, 'You do not have permission to adjust inventory stock.')

  const drugId = assertRequiredText(payload.drugId, 'Drug ID')
  const existingDrug = await getDrugForOrganization(adminClient, organizationId, drugId)
  const drugData = (payload.drug || {}) as Record<string, unknown>
  const name = assertRequiredText(drugData.name, 'Drug name')
  const batchNumber = normalizeText(drugData.batchNumber) || null
  const isDefaultCatalogDrug = isDefaultMedicationBatchNumber(existingDrug.batch_number)

  if (isDefaultCatalogDrug) {
    if (
      normalizeText(name) !== normalizeText(existingDrug.name) ||
      normalizeText(batchNumber).toUpperCase() !== normalizeText(existingDrug.batch_number).toUpperCase()
    ) {
      throw new Error(DEFAULT_CATALOG_IDENTITY_ERROR)
    }
  } else {
    assertCustomBatchNumberAllowed(batchNumber)
  }

  const updatePayload: Record<string, unknown> = {
    name: isDefaultCatalogDrug ? existingDrug.name : name,
    batch_number: isDefaultCatalogDrug ? existingDrug.batch_number : batchNumber,
    expiry_date: assertRequiredText(drugData.expiryDate, 'Expiry date'),
    quantity: parseNonNegativeNumber(drugData.quantity, 'Quantity'),
    price: parseNonNegativeNumber(drugData.price, 'Price'),
    supplier: normalizeText(drugData.supplier) || null,
    sale_on_return: Boolean(drugData.saleOnReturn),
    updated_at: new Date().toISOString(),
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'costPrice')) {
    updatePayload.cost_price = parseNonNegativeNumber(drugData.costPrice ?? 0, 'Cost price')
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'category')) {
    updatePayload.category = normalizeText(drugData.category) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'description')) {
    updatePayload.description = normalizeText(drugData.description) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'reorderLevel')) {
    updatePayload.reorder_level = parseNonNegativeNumber(drugData.reorderLevel ?? 10, 'Reorder level')
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'unit')) {
    updatePayload.unit = normalizeText(drugData.unit) || 'tablet'
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'nhisCode')) {
    updatePayload.nhis_code = normalizeText(drugData.nhisCode) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'nhisPrice')) {
    updatePayload.nhis_price =
      drugData.nhisPrice === undefined ||
      drugData.nhisPrice === null ||
      normalizeText(drugData.nhisPrice) === ''
        ? null
        : parseNonNegativeNumber(drugData.nhisPrice, 'NHIS price')
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'nhisUnit')) {
    updatePayload.nhis_unit = normalizeText(drugData.nhisUnit) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'isNhisListed')) {
    updatePayload.is_nhis_listed = Boolean(drugData.isNhisListed)
  }

  // ✅ NHIS PHARMACY LEVEL PATCH START
  if (Object.prototype.hasOwnProperty.call(drugData, 'medicineAccessLevel')) {
    updatePayload.medicine_access_level = normalizeMedicineAccessLevelForSave(drugData.medicineAccessLevel)
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'requiredPharmacyLevel')) {
    updatePayload.required_pharmacy_level = normalizePharmacyLevelForSave(drugData.requiredPharmacyLevel)
  }
  // ✅ NHIS PHARMACY LEVEL PATCH END

  const { data, error } = await adminClient
    .from('drugs')
    .update(updatePayload)
    .eq('id', drugId)
    .eq('organization_id', organizationId)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

const deleteDrug = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireRole(
    requesterProfile,
    ['admin'],
    'Only admins can delete inventory items.'
  )

  const drugId = assertRequiredText(payload.drugId, 'Drug ID')
  const existingDrug = await getDrugForOrganization(adminClient, organizationId, drugId)

  if (isDefaultMedicationBatchNumber(existingDrug.batch_number)) {
    throw new Error(DEFAULT_CATALOG_DELETE_ERROR)
  }

  const { data, error } = await adminClient.rpc('recycle_inventory_drug', {
    p_drug_id: drugId,
    p_organization_id: organizationId,
    p_deleted_by: requesterProfile.id,
  })

  if (error) {
    throw error
  }

  return { ...existingDrug, status: 'inactive', recycle_bin_id: data?.id || null }
}

const bulkImportDrugs = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireStockAdjustmentAccess(requesterProfile, 'You do not have permission to adjust inventory stock.')

  const drugs = Array.isArray(payload.drugs) ? payload.drugs : []
  if (drugs.length === 0) {
    return {
      created: [],
      reactivated: [],
      updated: [],
      successful: [],
      failed: [],
    }
  }

  const results: {
    created: Array<Record<string, unknown>>
    reactivated: Array<Record<string, unknown>>
    updated: Array<Record<string, unknown>>
    successful: Array<Record<string, unknown>>
    failed: Array<Record<string, unknown>>
  } = {
    created: [],
    reactivated: [],
    updated: [],
    successful: [],
    failed: [],
  }

  const branchId = await getBranchIdForInventoryRequest(
    adminClient,
    organizationId,
    requesterProfile,
    payload
  )

  const normalizedRows = drugs.map((item) => {
    const row = item as Record<string, unknown>
    const batchNumber = normalizeText(row.batch_number) || null
    assertCustomBatchNumberAllowed(batchNumber)

    return {
      organization_id: organizationId,
      branch_id: branchId,
      name: assertRequiredText(row.name, 'Drug name'),
      batch_number: batchNumber,
      expiry_date: assertRequiredText(row.expiry_date, 'Expiry date'),
      quantity: parseNonNegativeNumber(row.quantity, 'Quantity'),
      price: parseNonNegativeNumber(row.price, 'Price'),
      cost_price: parseNonNegativeNumber(row.cost_price ?? 0, 'Cost price'),
      nhis_code: normalizeText(row.nhis_code) || null,
      nhis_price:
        row.nhis_price === undefined || row.nhis_price === null || normalizeText(row.nhis_price) === ''
          ? null
          : parseNonNegativeNumber(row.nhis_price, 'NHIS price'),
      nhis_unit: normalizeText(row.nhis_unit) || null,
      is_nhis_listed: Boolean(row.is_nhis_listed),
      supplier: normalizeText(row.supplier) || null,
      category: normalizeText(row.category) || null,
      description: normalizeText(row.description) || null,
      reorder_level: parseNonNegativeNumber(row.reorder_level ?? 10, 'Reorder level'),
      unit: normalizeText(row.unit) || 'tablet',
    }
  })

  for (const drug of normalizedRows) {
    try {
      const { action, drug: savedDrug } = await saveDrugForOrganization(adminClient, organizationId, branchId, drug)
      results.successful.push(savedDrug)

      if (action === 'reactivate') {
        results.reactivated.push(savedDrug)
      } else if (action === 'update_existing') {
        results.updated.push(savedDrug)
      } else {
        results.created.push(savedDrug)
      }
    } catch (error) {
      results.failed.push({
        drug,
        error: getErrorMessage(error),
      })
    }
  }

  return results
}

const syncNhisDrugsToInventory = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireNhisCatalogAccess(requesterProfile, 'Only NHIS or inventory staff can sync NHIS medicines to inventory.')

  const drugs = Array.isArray(payload.drugs) ? payload.drugs : []
  if (drugs.length === 0) {
    return { upserted: 0 }
  }

  const branchIds = await getBranchIdsForInventorySync(
    adminClient,
    organizationId,
    requesterProfile,
    payload
  )

  const expiryDate = new Date()
  expiryDate.setFullYear(expiryDate.getFullYear() + 5)
  const fallbackExpiryDate = expiryDate.toISOString().split('T')[0]

  const sourceRows = drugs
    .map((item) => {
      const row = item as Record<string, unknown>
      const code = assertRequiredText(row.code, 'NHIS code').toUpperCase()
      const description = assertRequiredText(row.description, 'NHIS medicine')
      const unitPrice = parseNonNegativeNumber(row.unit_price ?? row.unitPrice ?? 0, 'NHIS price')

      return {
        organization_id: organizationId,
        name: description,
        batch_number: `NHIS-${code}`,
        expiry_date: fallbackExpiryDate,
        quantity: 0,
        unit: normalizeText(row.unit) || 'unit',
        price: unitPrice,
        cost_price: 0,
        supplier: 'NHIS',
        category: normalizeText(row.category) || normalizeText(row.dosage_form) || 'NHIS',
        description: [
          normalizeText(row.generic_name),
          normalizeText(row.strength),
          normalizeText(row.dosage_form),
        ].filter(Boolean).join(' | ') || null,
        reorder_level: 0,
        status: 'active',
        nhis_code: code,
        nhis_price: unitPrice,
        nhis_unit: normalizeText(row.unit) || 'unit',
        is_nhis_listed: true,
        updated_at: new Date().toISOString(),
      }
    })
    .filter((row) => row.nhis_code && row.name)

  const rows = branchIds.flatMap((branchId) =>
    sourceRows.map((row) => ({
      ...row,
      branch_id: branchId,
    }))
  )

  let upserted = 0
  for (const row of rows) {
    const branchId = normalizeText(row.branch_id) || null
    const existingDrug =
      (await findActiveDrugByNhisCode(adminClient, organizationId, branchId, String(row.nhis_code))) ||
      (await findActiveDrugByName(adminClient, organizationId, branchId, String(row.name))) ||
      (await findDrugByIdentity(
        adminClient,
        organizationId,
        branchId,
        String(row.name),
        String(row.batch_number)
      ))

    if (existingDrug) {
      const existingPrice = Number(existingDrug.price ?? 0)
      const { error } = await adminClient
        .from('drugs')
        .update({
          nhis_code: row.nhis_code,
          nhis_price: row.nhis_price,
          nhis_unit: row.nhis_unit,
          is_nhis_listed: true,
          name: normalizeText(existingDrug.name) || row.name,
          batch_number: normalizeText(existingDrug.batch_number) || row.batch_number,
          expiry_date: existingDrug.expiry_date || row.expiry_date,
          quantity: existingDrug.quantity ?? row.quantity,
          unit: normalizeText(existingDrug.unit) || row.unit,
          price: existingPrice > 0 ? existingDrug.price : row.price,
          cost_price: existingDrug.cost_price ?? row.cost_price,
          supplier: normalizeText(existingDrug.supplier) || row.supplier,
          category: normalizeText(existingDrug.category) || row.category,
          description: normalizeText(existingDrug.description) || row.description,
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingDrug.id)
        .eq('organization_id', organizationId)

      if (error) {
        throw error
      }

      upserted += 1
      continue
    }

    const { error } = await adminClient.from('drugs').insert([row])

    if (error) {
      throw error
    }

    upserted += 1
  }

  return { upserted, branches: branchIds.length }
}

const normalizeCredentialMode = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase()
  return ['api_key', 'bearer_token', 'basic_auth', 'oauth_client', 'claimit_token', 'custom'].includes(normalized)
    ? normalized
    : 'claimit_token'
}

const normalizeExportFormat = (value: unknown) =>
  normalizeText(value).toLowerCase() === 'xml' ? 'xml' : 'json'

const NHIA_SECRET_MASK = '\u2022'.repeat(8)
const NHIA_SECRET_FIELDS = new Set(['apiKey', 'apiSecret', 'username', 'password'])
const NHIA_CREDENTIAL_DECODE_ERROR =
  'NHIA credentials are saved, but HealthFlow could not decode them. Check the Supabase encryption key, then re-save the NHIA API credentials.'
const NHIA_SECRET_PREFIX = 'hfsec:aesgcm:v1:'
const NHIA_LEGACY_SECRET_PREFIX = 'hfsec:v1:'
const NHIA_SECRET_MASK_VALUES = new Set([NHIA_SECRET_MASK, '\u2022'.repeat(8), '\u2022'.repeat(12)])
const nhiaSecretKeyPromises = new Map<string, Promise<CryptoKey>>()

const maskCredentials = (payload: Record<string, unknown> = {}) =>
  Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, Boolean(normalizeText(value))]))

const isNhiaSecretMask = (value: unknown) => NHIA_SECRET_MASK_VALUES.has(normalizeText(value))

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const base64ToBytes = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

const decodeLegacyNhiaSecret = (value: string) => {
  try {
    return new TextDecoder().decode(base64ToBytes(value.slice(NHIA_LEGACY_SECRET_PREFIX.length)))
  } catch {
    return ''
  }
}

const getNhiaSecretKeyMaterials = () =>
  [
    normalizeText(Deno.env.get('NHIA_CONFIG_SECRET_KEY')),
    normalizeText(Deno.env.get('NHIA_SECRET_KEY')),
    normalizeText(Deno.env.get('SERVICE_ROLE_KEY')),
    normalizeText(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')),
  ].filter((value, index, values) => value && values.indexOf(value) === index)

const getPrimaryNhiaSecretKeyMaterial = () => getNhiaSecretKeyMaterials()[0] || ''

const getNhiaSecretKey = async (keyMaterial = getPrimaryNhiaSecretKeyMaterial()) => {
  if (!keyMaterial) {
    throw new Error('Missing NHIA_CONFIG_SECRET_KEY for NHIA secret encryption.')
  }

  if (!nhiaSecretKeyPromises.has(keyMaterial)) {
    nhiaSecretKeyPromises.set(keyMaterial, crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(keyMaterial))
      .then((digest) =>
        crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
      ))
  }

  return nhiaSecretKeyPromises.get(keyMaterial) as Promise<CryptoKey>
}

const encodeNhiaSecret = async (value: unknown) => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (normalized.startsWith(NHIA_SECRET_PREFIX)) return normalized
  const plaintext = normalized.startsWith(NHIA_LEGACY_SECRET_PREFIX)
    ? decodeLegacyNhiaSecret(normalized)
    : normalized
  if (!plaintext) return ''
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await getNhiaSecretKey()
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  )
  return `${NHIA_SECRET_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`
}

const decodeNhiaSecret = async (value: unknown) => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (normalized.startsWith(NHIA_LEGACY_SECRET_PREFIX)) {
    return decodeLegacyNhiaSecret(normalized)
  }
  if (!normalized.startsWith(NHIA_SECRET_PREFIX)) return normalized
  const [ivEncoded, ciphertextEncoded] = normalized.slice(NHIA_SECRET_PREFIX.length).split(':')
  if (!ivEncoded || !ciphertextEncoded) {
    throw new Error('Invalid NHIA secret ciphertext.')
  }
  for (const keyMaterial of getNhiaSecretKeyMaterials()) {
    try {
      const key = await getNhiaSecretKey(keyMaterial)
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(ivEncoded) },
        key,
        base64ToBytes(ciphertextEncoded)
      )
      return new TextDecoder().decode(plaintext)
    } catch {
      // Try the next configured legacy key material.
    }
  }
  throw new Error('Unable to decrypt NHIA secret. Check NHIA_CONFIG_SECRET_KEY.')
}

const logNhiaSecretDecryptDebug = (field: string, value: unknown, success: boolean) => {
  const encrypted = normalizeText(value)
  console.info('[NHIA CONFIG] secret decrypt debug', {
    field,
    encryptedLength: encrypted.length,
    keyExists: Boolean(getPrimaryNhiaSecretKeyMaterial()),
    decryptSuccess: Boolean(success),
  })
}

const safeDecodeNhiaSecret = async (value: unknown, field = 'secret') => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  try {
    const decoded = await decodeNhiaSecret(normalized)
    logNhiaSecretDecryptDebug(field, normalized, true)
    return decoded
  } catch {
    logNhiaSecretDecryptDebug(field, normalized, false)
    return ''
  }
}

const logNhiaConfigEvent = (event: string, details: Record<string, unknown> = {}) => {
  console.info(`[NHIA CONFIG] ${event}`, {
    organizationId: details.organizationId || details.organization_id || '',
    branchId: details.branchId || details.branch_id || '',
    table: details.table || 'nhia_configuration',
    source: details.source || details.configSource || '',
    mode: details.mode || '',
    saveTarget: details.saveTarget || '',
    endpoint: details.endpoint || '',
    saveSuccess: details.saveSuccess ?? null,
    saveFailed: details.saveFailed ?? null,
    configSource: details.configSource || '',
    hasApiKey: Boolean(details.hasApiKey),
    hasApiSecret: Boolean(details.hasApiSecret),
    apiBaseUrl: details.apiBaseUrl || details.api_base_url || '',
    memberLookupEndpointPath: details.memberLookupEndpointPath || details.member_lookup_endpoint_path || '',
    credentialMode: details.credentialMode || details.credential_mode || '',
  })
}

const mapNhiaSettingsRow = async (row: Record<string, unknown> | null, includeCredentials = false) => {
  if (!row) return null
  const credentials = includeCredentials
    ? {
        apiKey: await safeDecodeNhiaSecret(row.api_key_encrypted, 'apiKey'),
        apiSecret: await safeDecodeNhiaSecret(row.api_secret_encrypted, 'apiSecret'),
        headerName: row.api_key_header_name || '',
        secretHeaderName: row.api_secret_header_name || '',
        headerPrefix: row.api_key_header_prefix || '',
        username: row.username || '',
        password: await safeDecodeNhiaSecret(row.password_encrypted, 'password'),
        tokenEndpointPath: row.token_endpoint_path || '',
      }
    : {}
  const hasStoredApiKey = Boolean(row.api_key_encrypted)
  const hasStoredApiSecret = Boolean(row.api_secret_encrypted)
  const hasStoredPassword = Boolean(row.password_encrypted)
  const apiCredentialDecodeFailed = includeCredentials && Boolean(
    (hasStoredApiKey && !credentials.apiKey) ||
      (hasStoredApiSecret && !credentials.apiSecret)
  )
  const credentialDecodeFailed = includeCredentials && Boolean(
    apiCredentialDecodeFailed ||
      (hasStoredPassword && !credentials.password)
  )
  const credentialSummary = includeCredentials
    ? maskCredentials(credentials)
    : {
        apiKey: hasStoredApiKey,
        apiSecret: hasStoredApiSecret,
        password: hasStoredPassword,
        username: Boolean(row.username),
      }

  return {
    id: row.id,
    organizationId: row.organization_id || '',
    branchId: row.branch_id || '',
    mode: row.mode || 'ONLINE_CLOUD',
    providerId: row.provider_id || row.provider_number || '',
    facilityCode: row.facility_code || '',
    providerNumber: row.provider_number || row.provider_id || '',
    schemeName: row.scheme_name || 'National Health Insurance',
    // ✅ NHIA CONFIG PATCH START
    facilityType: row.facility_type || '',
    pharmacyFacilityLevel: row.pharmacy_facility_level || '',
    providerLevelCode: row.provider_level_code || '',
    credentialCode: row.credential_code || row.facility_code || '',
    licenseNumber: row.license_number || '',
    accreditationExpiryDate: getNhiaAccreditationExpiryDate(row),
    // ✅ NHIA CONFIG PATCH END
    // ✅ NHIA API ARCHITECTURE PATCH START
    integrationMode: row.integration_mode || 'claimit_export',
    connectionProfile: row.connection_profile || 'local_server',
    validationMode: row.validation_mode || 'validate_before_submit',
    claimControlMode: row.claim_control_mode ||
      (normalizeText(row.integration_mode) === 'claimit_bridge'
        ? 'claimit_bridge'
        : normalizeText(row.integration_mode) === 'direct_nhia_api'
          ? 'direct_api'
          : 'manual'),
    sandboxBaseUrl: row.sandbox_base_url || '',
    productionBaseUrl: row.production_base_url || '',
    // ✅ NHIA API ARCHITECTURE PATCH END
    providerTypeDescription: row.provider_type_description || '',
    providerClassLevel: row.provider_class_level || '',
    claimsOfficerName: row.claims_officer_name || '',
    admissionPaymentOption: row.admission_payment_option || 'nhis_pays_admission',
    claimitValidationEnabled: row.claimit_validation_enabled !== false,
    claimsOfficerSignatureUrl: row.claims_officer_signature_url || '',
    submitterId: row.submitter_id || '',
    nhiaApiMode: row.nhia_api_mode || row.integration_mode || 'claimit_export',
    nhia_api_mode: row.nhia_api_mode || row.integration_mode || 'claimit_export',
    apiEnvironment: row.api_environment || 'production',
    // Detect legacy rows where api_base_url held the CLAIM-it bridge URL
    // (e.g. https://*.vercel.app/json-api or localhost:31719).
    // In those cases move it to claimitSubmitBaseUrl and leave apiBaseUrl blank
    // so the admin sees the right field to fill with the NHIA eligibility URL.
    apiBaseUrl: (() => {
      const stored = normalizeText(row.api_base_url)
      if (!stored) return ''
      const isClaimItUrl = stored.includes('localhost') ||
        stored.includes('/json-api') ||
        stored.includes('/xml-api') ||
        stored.includes('31719') ||
        (!stored.includes('nhia.gov.gh') && (stored.includes('.vercel.app') || stored.includes('.healthflow')))
      return isClaimItUrl ? '' : stored
    })(),
    claimitSubmitBaseUrl: (() => {
      const fromProductionUrl = normalizeText(row.production_base_url)
      if (fromProductionUrl) return fromProductionUrl
      // Migrate: if api_base_url was a CLAIM-it URL, move it here
      const stored = normalizeText(row.api_base_url)
      if (!stored) return ''
      const isClaimItUrl = stored.includes('localhost') ||
        stored.includes('/json-api') ||
        stored.includes('/xml-api') ||
        stored.includes('31719') ||
        (!stored.includes('nhia.gov.gh') && (stored.includes('.vercel.app') || stored.includes('.healthflow')))
      return isClaimItUrl ? stored : ''
    })(),
    apiKeyEncrypted: row.api_key_encrypted ? NHIA_SECRET_MASK : '',
    apiSecretEncrypted: row.api_secret_encrypted ? NHIA_SECRET_MASK : '',
    claimEndpointPath: row.claim_endpoint_path || row.claim_submit_endpoint || '',
    claimSubmitEndpoint: row.claim_submit_endpoint || row.claim_endpoint_path || '',
    claim_submit_endpoint: row.claim_submit_endpoint || row.claim_endpoint_path || '',
    claimValidationEndpointPath: row.claim_validation_endpoint_path || '',
    ccEndpointPath: row.cc_endpoint_path || row.cc_code_endpoint_path || '',
    ccCodeEndpointPath: row.cc_code_endpoint_path || '',
    claimStatusEndpointPath: row.claim_status_endpoint_path || row.claim_status_endpoint || '',
    claimStatusEndpoint: row.claim_status_endpoint || row.claim_status_endpoint_path || '',
    claim_status_endpoint: row.claim_status_endpoint || row.claim_status_endpoint_path || '',
    memberLookupEndpointPath: row.member_lookup_endpoint_path || row.member_lookup_endpoint || '',
    memberLookupEndpoint: row.member_lookup_endpoint || row.member_lookup_endpoint_path || '',
    member_lookup_endpoint: row.member_lookup_endpoint || row.member_lookup_endpoint_path || '',
    directApiEnabled: Boolean(row.direct_api_enabled),
    credentialMode: row.credential_mode || 'claimit_token',
    credentials: includeCredentials ? credentials : {},
    credentialSummary,
    credentialDecodeFailed,
    credential_decode_failed: credentialDecodeFailed,
    apiCredentialDecodeFailed,
    api_credential_decode_failed: apiCredentialDecodeFailed,
    requiresCredentialReentry: credentialDecodeFailed,
    requires_credential_reentry: credentialDecodeFailed,
    credentialWarning: credentialDecodeFailed
      ? NHIA_CREDENTIAL_DECODE_ERROR
      : '',
    username: includeCredentials ? row.username || '' : '',
    hasUsername: Boolean(row.username),
    has_username: Boolean(row.username),
    passwordEncrypted: row.password_encrypted ? NHIA_SECRET_MASK : '',
    hasStoredPassword,
    has_stored_password: hasStoredPassword,
    hasPassword: hasStoredPassword,
    hasStoredApiKey,
    has_stored_api_key: hasStoredApiKey,
    hasApiKey: includeCredentials ? Boolean(credentials.apiKey) : hasStoredApiKey,
    has_api_key: includeCredentials ? Boolean(credentials.apiKey) : hasStoredApiKey,
    hasStoredApiSecret,
    has_stored_api_secret: hasStoredApiSecret,
    hasApiSecret: includeCredentials ? Boolean(credentials.apiSecret) : hasStoredApiSecret,
    has_api_secret: includeCredentials ? Boolean(credentials.apiSecret) : hasStoredApiSecret,
    nhisMemberDigits: Number(row.nhis_member_digits || 8),
    ghanaCardDigits: Number(row.ghana_card_digits || 10),
    exportFormat: row.export_format || 'json',
    maxRetryAttempts: Number(row.max_retry_attempts || 3),
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || '',
  }
}

const hasWritableNhiaSecret = (credentials: Record<string, unknown>, key: string) =>
  normalizeText(credentials[key]) && !isNhiaSecretMask(credentials[key])

const hasUsableNhiaSecret = (value: unknown) => {
  const normalized = normalizeText(value)
  return Boolean(normalized && !isNhiaSecretMask(normalized))
}

const validateNhiaSettingsForMode = (settings: Record<string, unknown>) => {
  const credentials = (settings.credentials && typeof settings.credentials === 'object'
    ? settings.credentials
    : {}) as Record<string, unknown>
  const integrationMode = normalizeText(settings.integrationMode || settings.integration_mode || settings.nhiaApiMode || settings.nhia_api_mode) || 'claimit_export'
  const hasApiKey = Boolean(settings.hasApiKey || settings.has_api_key || (settings.credentialSummary as Record<string, unknown> | undefined)?.apiKey || hasUsableNhiaSecret(credentials.apiKey))
  const hasApiSecret = Boolean(settings.hasApiSecret || settings.has_api_secret || (settings.credentialSummary as Record<string, unknown> | undefined)?.apiSecret || hasUsableNhiaSecret(credentials.apiSecret))
  const hasUsername = Boolean(normalizeText(settings.username || credentials.username))
  const hasPassword = Boolean(settings.hasPassword || settings.has_password || (settings.credentialSummary as Record<string, unknown> | undefined)?.password || hasUsableNhiaSecret(credentials.password))
  const missing = [
    !normalizeText(settings.providerId || settings.provider_id || settings.providerNumber || settings.provider_number) && 'providerId',
    !normalizeText(settings.credentialCode || settings.credential_code) && 'credentialCode',
    !getNhiaAccreditationExpiryDate(settings) && 'accreditationExpiryDate',
    !normalizeText(settings.claimsOfficerName || settings.claims_officer_name) && 'claimsOfficerName',
  ].filter(Boolean) as string[]
  const apiBaseUrl = normalizeText(settings.apiBaseUrl || settings.api_base_url || settings.sandboxBaseUrl || settings.sandbox_base_url)
  const claimitSubmitBaseUrl = normalizeText(settings.claimitSubmitBaseUrl || settings.claimit_submit_base_url || settings.productionBaseUrl || settings.production_base_url)
  const claimSubmitEndpoint = normalizeText(settings.claimSubmitEndpoint || settings.claim_submit_endpoint || settings.claimEndpointPath || settings.claim_endpoint_path)
  const claimStatusEndpoint = normalizeText(settings.claimStatusEndpoint || settings.claim_status_endpoint || settings.claimStatusEndpointPath || settings.claim_status_endpoint_path)
  const memberLookupEndpoint = normalizeText(settings.memberLookupEndpoint || settings.member_lookup_endpoint || settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path)

  if (integrationMode === 'claimit_assisted') {
    if (!apiBaseUrl) missing.push('apiBaseUrl')
    if (!hasApiKey) missing.push('NHIA CCC apiKey')
    if (!hasApiSecret) missing.push('NHIA CCC apiSecret')
    if (!memberLookupEndpoint) missing.push('memberLookupEndpoint')
  }

  if (integrationMode === 'claimit_bridge') {
    if (!apiBaseUrl) missing.push('apiBaseUrl')
    if (!claimitSubmitBaseUrl) missing.push('claimitSubmitBaseUrl')
    if (!hasApiKey) missing.push('NHIA CCC apiKey')
    if (!hasApiSecret) missing.push('NHIA CCC apiSecret')
    if (!hasUsername) missing.push('ClaimIt username')
    if (!hasPassword) missing.push('ClaimIt password')
    if (!claimSubmitEndpoint) missing.push('claimSubmitEndpoint')
    if (!memberLookupEndpoint) missing.push('memberLookupEndpoint')
  }

  if (integrationMode === 'direct_nhia_api' || integrationMode === 'hybrid') {
    if (!apiBaseUrl) missing.push('apiBaseUrl')
    if (!normalizeText(settings.submitterId || settings.submitter_id)) missing.push('submitterId')
    if (!hasApiKey) missing.push('apiKey')
    if (!hasApiSecret) missing.push('apiSecret')
    if (!claimSubmitEndpoint) missing.push('claimSubmitEndpoint')
    if (!claimStatusEndpoint) missing.push('claimStatusEndpoint')
    if (!memberLookupEndpoint) missing.push('memberLookupEndpoint')
  }

  if (missing.length) {
    throw new NhiaSettingsValidationError(integrationMode, missing)
  }
}

const fetchNhiaSettingsRow = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId = ''
) => {
  let query = adminClient
    .from('nhia_configuration')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('is_active', true)

  query = branchId
    ? query.eq('branch_id', branchId)
    : query.is('branch_id', null)

  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return (data as Record<string, unknown> | null) || null
}

const getNhiaApiSettings = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  includeCredentials = false,
  branchId = ''
) => {
  requireNhiaAccess(requesterProfile, 'Only NHIS staff can access NHIA API settings.')
  const scopedBranchId = resolveScopedBranchId(requesterProfile, { branchId })

  const scopedRow = scopedBranchId
    ? await fetchNhiaSettingsRow(adminClient, organizationId, scopedBranchId)
    : null
  const organizationRow = await fetchNhiaSettingsRow(adminClient, organizationId)
  const data = scopedRow || organizationRow
  const settings = await mapNhiaSettingsRow(data, includeCredentials)
  logNhiaConfigEvent('load', {
    mode: settings?.mode || 'ONLINE_CLOUD',
    endpoint: 'nhia_configuration',
    configSource: 'cloud_supabase',
    source: scopedRow ? 'branch_override' : 'organization_default',
    organizationId,
    branchId: settings?.branchId || scopedBranchId,
    hasApiKey: settings?.hasApiKey,
    hasApiSecret: settings?.hasApiSecret,
    apiBaseUrl: settings?.apiBaseUrl,
    memberLookupEndpointPath: settings?.memberLookupEndpointPath,
    credentialMode: settings?.credentialMode,
  })
  return settings
}

const saveNhiaApiSettings = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireNhiaSettingsAccess(requesterProfile, 'Only organization admins can update NHIA API settings.')

  const nestedPayload =
    payload.payload && typeof payload.payload === 'object'
      ? payload.payload
      : payload.data && typeof payload.data === 'object'
        ? payload.data
        : null
  const settings = (payload.settings || nestedPayload || {}) as Record<string, unknown>
  const scopedBranchId = resolveScopedBranchId(requesterProfile, {
    ...payload,
    ...settings,
  })
  const incomingCredentials =
    settings.credentials && typeof settings.credentials === 'object'
      ? (settings.credentials as Record<string, unknown>)
      : {}
  const existingRow = await fetchNhiaSettingsRow(adminClient, organizationId, scopedBranchId)
  const existing = await mapNhiaSettingsRow(existingRow, true)
  const credentials = { ...(existing?.credentials || {}) } as Record<string, unknown>

  for (const [key, value] of Object.entries(incomingCredentials)) {
    if (NHIA_SECRET_FIELDS.has(key) && (!normalizeText(value) || isNhiaSecretMask(value))) continue
    if (normalizeText(value)) credentials[key] = value
  }
  const hasApiKey = Boolean(normalizeText(credentials.apiKey))
  const hasApiSecret = Boolean(normalizeText(credentials.apiSecret))
  const shouldWritePassword = hasWritableNhiaSecret(credentials, 'password')
  logNhiaConfigEvent('save started', {
    organizationId,
    branchId: scopedBranchId,
    mode: 'ONLINE_CLOUD',
    saveTarget: 'cloud_supabase',
    endpoint: 'nhia_configuration',
    hasApiKey,
    hasApiSecret,
    apiBaseUrl: settings.apiBaseUrl || settings.api_base_url,
    memberLookupEndpointPath: settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path,
    credentialMode: settings.credentialMode || settings.credential_mode,
  })
  validateNhiaSettingsForMode({
    ...settings,
    credentials,
    hasApiKey,
    hasApiSecret,
    hasPassword: Boolean(normalizeText(credentials.password)),
  })

  const accreditationExpiryDate = getNhiaAccreditationExpiryDate(settings)
  const claimsOfficerName = normalizeText(settings.claimsOfficerName ?? settings.claims_officer_name)
  const facilityCode = normalizeText(settings.facilityCode || settings.facility_code)
  const providerNumber = normalizeText(settings.providerNumber || settings.provider_number || settings.providerId || settings.provider_id)
  const schemeName = normalizeText(settings.schemeName || settings.scheme_name) || 'National Health Insurance'
  const facilityType = normalizeText(settings.facilityType || settings.facility_type)
  const pharmacyFacilityLevel = normalizeText(settings.pharmacyFacilityLevel || settings.pharmacy_facility_level)
  const providerLevelCode = normalizeText(settings.providerLevelCode || settings.provider_level_code)
  const credentialCode = normalizeText(settings.credentialCode || settings.credential_code || facilityCode)
  const licenseNumber = normalizeText(settings.licenseNumber || settings.license_number)
  const providerTypeDescription = normalizeText(settings.providerTypeDescription || settings.provider_type_description)
  const providerClassLevel = normalizeText(settings.providerClassLevel || settings.provider_class_level)

  const row = {
    organization_id: organizationId,
    branch_id: scopedBranchId || null,
    mode: 'ONLINE_CLOUD',
    provider_id: providerNumber || null,
    facility_code: facilityCode || null,
    provider_number: providerNumber || null,
    scheme_name: schemeName,
    // ✅ NHIA CONFIG PATCH START
    facility_type: facilityType || null,
    pharmacy_facility_level: pharmacyFacilityLevel || null,
    provider_level_code: providerLevelCode || null,
    credential_code: credentialCode || null,
    license_number: licenseNumber || null,
    accreditation_expiry_date: accreditationExpiryDate || null,
    // ✅ NHIA CONFIG PATCH END
    // ✅ NHIA API ARCHITECTURE PATCH START
    integration_mode: normalizeText(settings.integrationMode || settings.integration_mode || settings.nhiaApiMode || settings.nhia_api_mode) || 'claimit_export',
    connection_profile: normalizeText(settings.connectionProfile || settings.connection_profile) || 'local_server',
    validation_mode: normalizeText(settings.validationMode || settings.validation_mode) || 'validate_before_submit',
    claim_control_mode: ['manual', 'claimit_bridge', 'direct_api'].includes(normalizeText(settings.claimControlMode || settings.claim_control_mode))
      ? normalizeText(settings.claimControlMode || settings.claim_control_mode)
      : 'manual',
    sandbox_base_url: normalizeText(settings.sandboxBaseUrl).replace(/\/+$/, '') || null,
    // production_base_url stores the CLAIM-it local submit URL.
    // claimitSubmitBaseUrl takes precedence; productionBaseUrl is a fallback.
    production_base_url: normalizeText(
      settings.claimitSubmitBaseUrl || settings.claimit_submit_base_url || settings.productionBaseUrl
    ).replace(/\/+$/, '') || null,
    // ✅ NHIA API ARCHITECTURE PATCH END
    provider_type_description: providerTypeDescription || null,
    provider_class_level: providerClassLevel || null,
    claims_officer_name: claimsOfficerName || null,
    admission_payment_option: ['nhis_pays_admission', 'patient_pays_admission', 'not_applicable'].includes(
      normalizeText(settings.admissionPaymentOption)
    )
      ? normalizeText(settings.admissionPaymentOption)
      : 'nhis_pays_admission',
    claimit_validation_enabled: settings.claimitValidationEnabled !== false,
    claims_officer_signature_url: normalizeText(settings.claimsOfficerSignatureUrl) || null,
    submitter_id: normalizeText(settings.submitterId) || null,
    api_environment: normalizeText(settings.apiEnvironment).toLowerCase() === 'sandbox' ? 'sandbox' : 'production',
    api_base_url: normalizeText(
      settings.apiBaseUrl ||
        (normalizeText(settings.apiEnvironment).toLowerCase() === 'sandbox'
          ? settings.sandboxBaseUrl
          : '')
    ).replace(/\/+$/, '') || null,
    api_key_encrypted: hasApiKey ? await encodeNhiaSecret(credentials.apiKey) : null,
    api_secret_encrypted: hasApiSecret ? await encodeNhiaSecret(credentials.apiSecret) : null,
    has_api_key: hasApiKey,
    has_api_secret: hasApiSecret,
    api_key_header_name: normalizeText(credentials.headerName) || null,
    api_secret_header_name: normalizeText(credentials.secretHeaderName) || null,
    api_key_header_prefix: normalizeText(credentials.headerPrefix) || null,
    username: normalizeText(settings.username || credentials.username) || null,
    password_encrypted: shouldWritePassword ? await encodeNhiaSecret(credentials.password) : null,
    token_endpoint_path: normalizeText(credentials.tokenEndpointPath) || null,
    claim_endpoint_path: normalizeText(settings.claimEndpointPath || settings.claim_endpoint_path || settings.claimSubmitEndpoint || settings.claim_submit_endpoint) || null,
    claim_submit_endpoint: normalizeText(settings.claimSubmitEndpoint || settings.claim_submit_endpoint || settings.claimEndpointPath || settings.claim_endpoint_path) || null,
    claim_validation_endpoint_path: normalizeText(settings.claimValidationEndpointPath || settings.claim_validation_endpoint_path) || null,
    cc_endpoint_path: normalizeText(settings.ccEndpointPath || settings.cc_endpoint_path || settings.ccCodeEndpointPath || settings.cc_code_endpoint_path) || null,
    cc_code_endpoint_path: normalizeText(settings.ccCodeEndpointPath || settings.cc_code_endpoint_path || settings.ccEndpointPath || settings.cc_endpoint_path) || null,
    claim_status_endpoint_path: normalizeText(settings.claimStatusEndpointPath || settings.claim_status_endpoint_path || settings.claimStatusEndpoint || settings.claim_status_endpoint) || null,
    claim_status_endpoint: normalizeText(settings.claimStatusEndpoint || settings.claim_status_endpoint || settings.claimStatusEndpointPath || settings.claim_status_endpoint_path) || null,
    member_lookup_endpoint_path: normalizeText(settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path || settings.memberLookupEndpoint || settings.member_lookup_endpoint) || null,
    member_lookup_endpoint: normalizeText(settings.memberLookupEndpoint || settings.member_lookup_endpoint || settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path) || null,
    direct_api_enabled: Boolean(settings.directApiEnabled),
    credential_mode: normalizeCredentialMode(settings.credentialMode),
    nhis_member_digits: Number(settings.nhisMemberDigits || 8),
    ghana_card_digits: Number(settings.ghanaCardDigits || 10),
    export_format: normalizeExportFormat(settings.exportFormat),
    max_retry_attempts: Math.min(Math.max(Number(settings.maxRetryAttempts || 3), 1), 10),
    is_active: true,
    updated_by: requesterProfile.id,
    updated_at: new Date().toISOString(),
    ...(existing?.id ? {} : { created_by: requesterProfile.id }),
  }

  const { error } = await adminClient
    .from('nhia_configuration')
    .upsert(row, { onConflict: 'organization_id,branch_id' })
    .select('id')
    .single()

  if (error) throw error
  const credentialReadBack = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, true, scopedBranchId)
  if (credentialReadBack?.apiCredentialDecodeFailed || credentialReadBack?.credentialDecodeFailed) {
    throw new Error(NHIA_CREDENTIAL_DECODE_ERROR)
  }
  if (hasApiKey && credentialReadBack?.hasApiKey !== true) {
    throw new Error('Saved NHIA API key could not be decrypted/read back from nhia_configuration. Re-save the NHIA API credentials.')
  }
  if (hasApiSecret && credentialReadBack?.hasApiSecret !== true) {
    throw new Error('Saved NHIA API secret could not be decrypted/read back from nhia_configuration. Re-save the NHIA API credentials.')
  }
  const savedSettings = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, false, scopedBranchId)
  logNhiaConfigEvent('save completed', {
    mode: 'ONLINE_CLOUD',
    saveTarget: 'cloud_supabase',
    endpoint: 'nhia_configuration',
    saveSuccess: true,
    configSource: 'cloud_supabase',
    source: 'service_role_readback',
    organizationId,
    branchId: savedSettings?.branchId || scopedBranchId,
    hasApiKey: savedSettings?.hasApiKey,
    hasApiSecret: savedSettings?.hasApiSecret,
    apiBaseUrl: savedSettings?.apiBaseUrl,
    memberLookupEndpointPath: savedSettings?.memberLookupEndpointPath,
    credentialMode: savedSettings?.credentialMode,
  })
  return { settings: savedSettings }
}

const removeNhiaApiCredentials = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown> = {}
) => {
  requireNhiaSettingsAccess(requesterProfile, 'Only organization admins can remove NHIA API credentials.')
  const scopedBranchId = resolveScopedBranchId(requesterProfile, payload)

  let query = adminClient
    .from('nhia_configuration')
    .update({
      api_key_encrypted: null,
      api_secret_encrypted: null,
      has_api_key: false,
      has_api_secret: false,
      updated_by: requesterProfile.id,
      updated_at: new Date().toISOString(),
    })
    .eq('organization_id', organizationId)

  query = scopedBranchId
    ? query.eq('branch_id', scopedBranchId)
    : query.is('branch_id', null)

  const { error } = await query
    .select('id')
    .maybeSingle()

  if (error) throw error

  const settings = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, false, scopedBranchId)
  logNhiaConfigEvent('credentials removed', {
    mode: settings?.mode || 'ONLINE_CLOUD',
    saveTarget: 'cloud_supabase',
    endpoint: 'nhia_configuration',
    saveSuccess: true,
    configSource: 'cloud_supabase',
    hasApiKey: false,
    hasApiSecret: false,
  })
  return { settings }
}

const joinUrl = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

const fetchClaimItToken = async (settings: Record<string, unknown>) => {
  const credentials = (settings.credentials || {}) as Record<string, unknown>
  const username = assertRequiredText(credentials.username, 'CLAIM-it username')
  const password = assertRequiredText(credentials.password, 'CLAIM-it password')
  const tokenPath = normalizeText(credentials.tokenEndpointPath) || '/token'
  const url = new URL(joinUrl(getClaimSubmitBaseUrl(settings), tokenPath))
  url.searchParams.set('username', username)
  url.searchParams.set('password', password)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
    },
  })
  const responseText = await response.text()
  let body: unknown = {}
  try {
    body = responseText ? JSON.parse(responseText) : {}
  } catch {
    body = { raw: responseText }
  }

  if (!response.ok) {
    throw new Error(`CLAIM-it token request returned HTTP ${response.status}.`)
  }

  const token = normalizeText((body as Record<string, unknown>)?.token)
  if (!token) {
    throw new Error('CLAIM-it token response did not include a token.')
  }

  return token
}

const buildNhiaHeaders = (settings: Record<string, unknown>, contentType = 'application/json') => {
  const credentials = (settings.credentials || {}) as Record<string, unknown>
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': contentType }
  const mode = normalizeCredentialMode(settings.credentialMode)
  const applyBasicCredentialsHeader = () => {
    const username = normalizeHttpHeaderValue(credentials.username)
    const password = normalizeHttpHeaderValue(credentials.password)
    if ((username || password) && !headers.Authorization) {
      headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`
    }
  }

  if (mode === 'api_key') {
    const configuredHeaderName = normalizeText(credentials.headerName)
    const headerName = configuredHeaderName || 'Authorization'
    const prefix = normalizeText(credentials.headerPrefix) ||
      (!configuredHeaderName && headerName.toLowerCase() === 'authorization' ? 'Bearer' : '')
    const apiKey = normalizeHttpHeaderValue(credentials.apiKey)
    if (apiKey) headers[headerName] = prefix ? `${prefix} ${apiKey}` : apiKey
    const apiSecret = normalizeHttpHeaderValue(credentials.apiSecret)
    const secretHeaderName = normalizeText(credentials.secretHeaderName) || 'x-api-secret'
    if (apiSecret) headers[secretHeaderName] = apiSecret
    applyBasicCredentialsHeader()
  } else if (mode === 'bearer_token') {
    const token = normalizeHttpHeaderValue(credentials.apiKey || credentials.token)
    if (token) headers.Authorization = `Bearer ${token}`
  } else if (mode === 'basic_auth') {
    const username = normalizeHttpHeaderValue(credentials.username)
    const password = normalizeHttpHeaderValue(credentials.password)
    if (username || password) headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`
  } else if (mode === 'oauth_client') {
    const token = normalizeHttpHeaderValue(credentials.accessToken || credentials.token || credentials.apiKey)
    if (token) headers.Authorization = `Bearer ${token}`
  }

  return headers
}

const buildNhiaSubmissionHeaders = async (
  settings: Record<string, unknown>,
  contentType = 'application/json'
) => {
  const mode = normalizeCredentialMode(settings.credentialMode)
  const headers = buildNhiaHeaders(settings, contentType)
  const credentials = (settings.credentials || {}) as Record<string, unknown>
  const hasClaimItTokenCredentials = Boolean(
    normalizeText(credentials.username) && normalizeText(credentials.password)
  )
  if (mode === 'claimit_token' || hasClaimItTokenCredentials) {
    Object.keys(headers).forEach((key) => {
      if (key.toLowerCase().startsWith('x-nhia-') || key.toLowerCase() === 'x-api-secret') {
        delete headers[key]
      }
    })
    headers.Authorization = `Bearer ${await fetchClaimItToken(settings)}`
  }
  return headers
}

const getScopedNhiaEligibilityCredentials = (
  settings: Record<string, unknown>,
  organizationId = '',
  branchId = ''
) => {
  const credentials = (settings.credentials || {}) as Record<string, unknown>
  const overrideOrganizationIds = [
    ...normalizeText(Deno.env.get('NHIA_API_ORGANIZATION_ID')).split(','),
    ...normalizeText(Deno.env.get('NHIA_API_ORGANIZATION_IDS')).split(','),
  ].map((value) => normalizeText(value)).filter(Boolean)
  const overrideBranchIds = [
    ...normalizeText(Deno.env.get('NHIA_API_BRANCH_ID')).split(','),
    ...normalizeText(Deno.env.get('NHIA_API_BRANCH_IDS')).split(','),
  ].map((value) => normalizeText(value)).filter(Boolean)
  const overrideApiKey = normalizeText(
    Deno.env.get('NHIA_API_KEY') ||
      Deno.env.get('CLAIMIT_UPSTREAM_API_KEY')
  )
  const overrideApiSecret = normalizeText(
    Deno.env.get('NHIA_API_SECRET') ||
      Deno.env.get('CLAIMIT_UPSTREAM_API_SECRET')
  )
  const normalizedOrganizationId = normalizeText(organizationId)
  const normalizedBranchId = normalizeText(branchId)
  const organizationMatches = Boolean(
    normalizedOrganizationId &&
      overrideOrganizationIds.includes(normalizedOrganizationId)
  )
  const branchMatches = overrideBranchIds.length === 0 ||
    Boolean(normalizedBranchId && overrideBranchIds.includes(normalizedBranchId))
  const canUseOverride = Boolean(
    overrideApiKey &&
      overrideApiSecret &&
      organizationMatches &&
      branchMatches
  )

  return {
    apiKey: canUseOverride
      ? normalizeHttpHeaderValue(overrideApiKey)
      : assertRequiredText(normalizeHttpHeaderValue(credentials.apiKey || credentials.token), 'NHIA CCC API key'),
    apiSecret: canUseOverride
      ? normalizeHttpHeaderValue(overrideApiSecret)
      : assertRequiredText(normalizeHttpHeaderValue(credentials.apiSecret), 'NHIA CCC API secret'),
    source: canUseOverride ? 'facility_scoped_env' : 'saved_configuration',
  }
}

const buildNhiaEligibilityHeaders = (
  settings: Record<string, unknown>,
  organizationId = '',
  branchId = ''
) => {
  const { apiKey, apiSecret } = getScopedNhiaEligibilityCredentials(
    settings,
    organizationId,
    branchId
  )
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-nhia-apikey': apiKey,
    'x-nhia-apisecret': apiSecret,
  }
}

const isClaimItBridgeMode = (settings: Record<string, unknown>) =>
  normalizeText(settings.integrationMode || settings.integration_mode) === 'claimit_bridge'

const mergeIncomingCredentials = (
  saved: Record<string, unknown> | null,
  incoming: Record<string, unknown>
) => {
  const savedCredentials = (saved?.credentials && typeof saved.credentials === 'object'
    ? saved.credentials
    : {}) as Record<string, unknown>
  const incomingCredentials = (incoming.credentials && typeof incoming.credentials === 'object'
    ? incoming.credentials
    : {}) as Record<string, unknown>
  const credentials = { ...savedCredentials }
  for (const [key, value] of Object.entries(incomingCredentials)) {
    if (normalizeText(value) && !isNhiaSecretMask(value)) credentials[key] = value
  }
  return credentials
}

const getClaimItConnectionSettings = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  const incoming = (payload.settings || payload) as Record<string, unknown>
  const saved = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, true)
  return {
    ...(saved || {}),
    ...incoming,
    credentials: mergeIncomingCredentials(saved, incoming),
  } as Record<string, unknown>
}

const testClaimItConnection = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireNhiaSettingsAccess(requesterProfile, 'Only organization admins can test CLAIM-it connection settings.')
  const settings = await getClaimItConnectionSettings(adminClient, requesterProfile, organizationId, payload)
  const baseUrl = getClaimSubmitBaseUrl(settings)
  if (!baseUrl) throw new Error('CLAIM-it bridge base URL is required.')

  const endpointPath = normalizeText(
    settings.claimValidationEndpointPath ||
      settings.claim_validation_endpoint_path ||
      settings.claimEndpointPath ||
      settings.claim_endpoint_path
  )
  const url = endpointPath ? joinUrl(baseUrl, endpointPath) : baseUrl.replace(/\/+$/, '')
  const response = await fetch(url, {
    method: 'GET',
    headers: await buildNhiaSubmissionHeaders(settings, 'application/json'),
  })

  if ([401, 403, 404, 405].includes(response.status)) {
    return { ok: true, status: response.status, message: `CLAIM-it bridge reached (HTTP ${response.status}).` }
  }
  if (!response.ok) throw new Error(`CLAIM-it bridge returned HTTP ${response.status}.`)
  return { ok: true, status: response.status, message: 'CLAIM-it bridge connection reached.' }
}

const validateClaimItBridgePayload = async (
  settings: Record<string, unknown>,
  requestBody: string,
  contentType: string
) => {
  if (!isClaimItBridgeMode(settings)) return
  const validationMode = normalizeText(settings.validationMode || settings.validation_mode) || 'validate_before_submit'
  const endpointPath = normalizeText(settings.claimValidationEndpointPath || settings.claim_validation_endpoint_path)
  if (validationMode === 'submit_only' || !endpointPath) return

  const response = await fetch(joinUrl(getClaimSubmitBaseUrl(settings), endpointPath), {
    method: 'POST',
    headers: await buildNhiaSubmissionHeaders(settings, contentType),
    body: requestBody,
  })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`CLAIM-it validation returned HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 240)}` : ''}`)
  }
}

const normalizeCcCode = (value: unknown): string =>
  String(value ?? '').trim().replace(/\D/g, '')

const extractCcCode = (body: unknown): string => {
  if (Array.isArray(body)) {
    for (const item of body) {
      const nested = extractCcCode(item)
      if (nested) return nested
    }
    return ''
  }
  if (!body || typeof body !== 'object') return ''
  const record = body as Record<string, unknown>
  const direct = normalizeCcCode(
    // NHIA member verification API returns MobCCC (Mobile Claims Check Code)
    record.MobCCC ||
      record.mobCCC ||
      record.mobccc ||
      record.MobileCCC ||
      record.ccCode ||
      record.cc_code ||
      record.cccCode ||
      record.ccc_code ||
      record.cccNo ||
      record.ccc_no ||
      record.claimControlCode ||
      record.claim_control_code ||
      record.controlCode ||
      record.control_code ||
      record.code
  )
  if (direct) return direct
  for (const key of ['data', 'claim', 'claims', 'result', 'results', 'response']) {
    const nested = extractCcCode(record[key])
    if (nested) return nested
  }
  return ''
}

const summarizeRemoteBody = (body: unknown): string => {
  if (!body) return ''
  if (typeof body === 'string') return body.slice(0, 240)
  if (typeof body === 'object') {
    const record = body as Record<string, unknown>
    const message = normalizeText(
      record.error ||
        record.message ||
        record.detail ||
        record.description ||
        (record.data && typeof record.data === 'object'
          ? (record.data as Record<string, unknown>).error ||
            (record.data as Record<string, unknown>).message ||
            (record.data as Record<string, unknown>).detail
          : '')
    )
    if (message) return message.slice(0, 240)
    try {
      return JSON.stringify(body).slice(0, 240)
    } catch {
      return ''
    }
  }
  return normalizeText(body).slice(0, 240)
}

const buildRemoteHttpError = (label: string, status: number, body: unknown) => {
  if (label === 'NHIA API' && status === 401) {
    return new Error('NHIA API rejected this facility\'s API key/secret. Re-save the correct NHIA API credentials for the facility.')
  }

  const summary = summarizeRemoteBody(body)
  return new Error(`${label} returned HTTP ${status}${summary ? `: ${summary}` : ''}`)
}

const isValidEndpointPath = (value: string): boolean => {
  if (!value) return false
  if (value.includes('@')) return false           // reject emails
  if (/^https?:\/\//i.test(value)) return false  // reject full URLs
  return value.startsWith('/') || /^[a-zA-Z0-9_-]/.test(value)
}

const getCcEndpointPath = (settings: Record<string, unknown>) => {
  const value = normalizeText(
    settings.ccEndpointPath ||
    settings.cc_endpoint_path ||
    settings.ccCodeEndpointPath ||
    settings.cc_code_endpoint_path
  )
  return isValidEndpointPath(value) ? value : ''
}

const getClaimSubmitEndpointPath = (settings: Record<string, unknown>) =>
  normalizeText(
    settings.claimEndpointPath ||
      settings.claim_endpoint_path ||
      settings.claimSubmitEndpoint ||
      settings.claim_submit_endpoint
  )

const getMemberLookupEndpointPath = (settings: Record<string, unknown>) =>
  normalizeText(
    settings.memberLookupEndpointPath ||
      settings.member_lookup_endpoint_path ||
      settings.memberLookupEndpoint ||
      settings.member_lookup_endpoint
  )

const isGhanaCardNumber = (value: unknown) =>
  /^GHA-\d{9}-\d$/i.test(normalizeText(value))

const getNhiaCardType = (memberNumber: unknown, explicitCardType: unknown = '') => {
  const cardType = normalizeText(explicitCardType).toUpperCase()
  if (cardType === 'NHISCARD' || cardType === 'GHANACARD') return cardType
  return isGhanaCardNumber(memberNumber) ? 'GHANACARD' : 'NHISCARD'
}

const mapNhiaMemberLookupResponse = (body: unknown) => {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const hin = normalizeText(
    record.HIN ||
      record.hin ||
      record.HINNo ||
      record.hinNo ||
      record.hin_no ||
      record.CardSerialNo ||
      record.cardSerialNo ||
      record.card_serial_no ||
      record.CardSerialNumber ||
      record.cardSerialNumber
  )
  return {
    ccCode: extractCcCode(body),
    memberName: normalizeText(record.MemberName || record.memberName || record.member_name),
    hin,
    gender: normalizeText(record.Gender || record.gender),
    dateOfBirth: normalizeText(record.DateOfBirth || record.dateOfBirth || record.date_of_birth).slice(0, 10) || null,
    eligibilityStartDate: normalizeText(record.EligibilityStartDate || record.eligibilityStartDate).slice(0, 10) || null,
    eligibilityEndDate: normalizeText(record.EligibilityEndDate || record.eligibilityEndDate).slice(0, 10) || null,
    status: normalizeText(record.Status || record.status),
    attendanceDate: normalizeText(record.AttendanceDate || record.attendanceDate).slice(0, 10) || null,
    authId: normalizeText(
      record.AuthID ||
        record.AuthId ||
        record.authID ||
        record.authId ||
        record.auth_id ||
        record.AuthorizationID ||
        record.authorizationId ||
        record.authorization_id
    ),
    transactionId: normalizeText(record.TransactionID || record.transactionId || record.transaction_id),
    hpName: normalizeText(record.HPName || record.hpName || record.hp_name),
    pppCode: normalizeText(record.PPPCode || record.pppCode) || null,
    pppName: normalizeText(record.PPPName || record.pppName) || null,
    raw: body,
  }
}

const getNhiaMemberLookupFailureMessage = (memberDetails: ReturnType<typeof mapNhiaMemberLookupResponse>) => {
  const status = normalizeText(memberDetails?.status)
  if (!memberDetails || memberDetails.ccCode || !status) return ''
  return `NHIA member lookup did not return a CC code: ${status}.`
}

// NHIA eligibility API base URL — used for member lookup (genCCC) and CC code generation.
// This is the apiBaseUrl configured directly (e.g. https://elig.nhia.gov.gh:5000).
const getNhiaApiBaseUrl = (settings: Record<string, unknown>) => {
  const environment = normalizeText(settings.apiEnvironment || settings.api_environment).toLowerCase()
  const apiBaseUrl = normalizeText(settings.apiBaseUrl || settings.api_base_url)
  const sandboxBaseUrl = normalizeText(settings.sandboxBaseUrl || settings.sandbox_base_url)
  return environment === 'sandbox'
    ? sandboxBaseUrl || apiBaseUrl
    : apiBaseUrl || sandboxBaseUrl
}

// CLAIM-it local software base URL — used for claim submission.
// Stored in production_base_url / claimitSubmitBaseUrl.
const getClaimSubmitBaseUrl = (settings: Record<string, unknown>) =>
  normalizeText(
    settings.claimitSubmitBaseUrl ||
    settings.claimit_submit_base_url ||
    settings.productionBaseUrl ||
    settings.production_base_url ||
    settings.apiBaseUrl ||
    settings.api_base_url
  )

const canUseBaseUrlForCcGeneration = (settings: Record<string, unknown>) => {
  const validationMode = normalizeText(settings.validationMode || settings.validation_mode)
  const integrationMode = normalizeText(settings.integrationMode || settings.integration_mode || settings.nhiaApiMode || settings.nhia_api_mode)
  const claimControlMode = normalizeText(settings.claimControlMode || settings.claim_control_mode)
  return validationMode === 'validate_before_submit' ||
    validationMode === 'claimit_local_bridge' ||
    integrationMode === 'claimit_export' ||
    integrationMode === 'claimit_local_bridge' ||
    claimControlMode === 'claimit_bridge_ccc' ||
    isClaimItBridgeMode(settings) ||
    Boolean(getNhiaApiBaseUrl(settings))
}

const logClaimItBridgeStatus = (action: string, detail: Record<string, unknown> = {}) => {
  console.info(`[CLAIM-it Bridge] ${action}`, JSON.stringify({
    status: normalizeText(detail.status),
    httpStatus: detail.httpStatus ?? null,
    endpointPath: normalizeText(detail.endpointPath),
    claimCount: detail.claimCount ?? null,
    message: normalizeText(detail.message),
  }))
}

const isSubscriberVerificationInvalid = (body: unknown): boolean => {
  if (!body || typeof body !== 'object') return false
  const record = body as Record<string, unknown>
  const status = normalizeText(record.status || record.outcome || record.result || record.validationStatus).toLowerCase()
  const valid = record.valid ?? record.isValid ?? record.verified ?? record.isVerified ?? record.success
  if (valid === false) return true
  if (['invalid', 'not_found', 'not found', 'failed', 'error', 'inactive'].includes(status)) return true
  return record.data && typeof record.data === 'object' ? isSubscriberVerificationInvalid(record.data) : false
}

const verifyClaimItSubscriber = async (
  settings: Record<string, unknown>,
  apiBaseUrl: string,
  payload: Record<string, unknown>
) => {
  const endpointPath = getMemberLookupEndpointPath(settings)
  if (!endpointPath) return null

  const requestPayload = {
    action: 'verify_subscriber',
    memberNumber: normalizeText(payload.memberNumber || payload.memberNo),
    hin: normalizeText(payload.hin),
    patientName: normalizeText(payload.patientName),
    serviceDate: normalizeText(payload.serviceDate),
  }
  logClaimItBridgeStatus('subscriber_verification.request', { status: 'pending', endpointPath })
  const response = await fetch(joinUrl(apiBaseUrl, endpointPath), {
    method: 'POST',
    headers: await buildNhiaSubmissionHeaders(settings),
    body: JSON.stringify(requestPayload),
  })
  const responseText = await response.text()
  let body: unknown = {}
  try {
    body = responseText ? JSON.parse(responseText) : {}
  } catch {
    body = { raw: responseText }
  }
  logClaimItBridgeStatus('subscriber_verification.response', {
    status: response.ok ? 'success' : 'failed',
    httpStatus: response.status,
    endpointPath,
  })
  if (!response.ok) throw buildRemoteHttpError('Subscriber verification', response.status, body)
  if (isSubscriberVerificationInvalid(body)) throw new Error('Subscriber verification failed.')
  return body
}

const generateNhiaCcCode = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireClaimsAccess(requesterProfile, 'Only claims staff can generate or change NHIA CC codes.')
  console.log('[GENERATE NHIA CC PAYLOAD]', redactTierAccessBody(payload))
  const receivedKeys = Object.keys(payload || {})
  const claimId = normalizeText(payload.claimId || payload.claim_id)
  if (!claimId) {
    return { ok: false, error: 'Missing claimId', receivedKeys }
  }

  let settings: Awaited<ReturnType<typeof getNhiaApiSettings>> | null = null
  let scopedBranchId = ''
  try {
    scopedBranchId = resolveScopedBranchId(requesterProfile, payload)
    settings = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, true, scopedBranchId)
  } catch (error) {
    return {
      ok: false,
      error: `Unable to load NHIA API settings: ${getErrorMessage(error)}`,
      receivedKeys,
    }
  }

  if (!settings) {
    return { ok: false, error: 'NHIA API settings not found for organization', receivedKeys }
  }

  if (!settings.directApiEnabled) {
    return { ok: false, error: 'Direct NHIA API is not enabled for organization', receivedKeys }
  }

  if (settings.apiCredentialDecodeFailed || settings.credentialDecodeFailed || settings.requiresCredentialReentry) {
    throw new Error(NHIA_CREDENTIAL_DECODE_ERROR)
  }

  const apiBaseUrl = getNhiaApiBaseUrl(settings as unknown as Record<string, unknown>)
  if (!apiBaseUrl) {
    return { ok: false, error: 'NHIA API base URL is not configured', receivedKeys }
  }

  const memberNumber = normalizeText(payload.memberNumber || payload.memberNo)
  if (!memberNumber) {
    return { ok: false, error: 'Member number is required for NHIA genCCC lookup', receivedKeys }
  }

  const endpointPath = getMemberLookupEndpointPath(settings as unknown as Record<string, unknown>) || '/api/hmis/genCCC'
  const finalUrl = joinUrl(apiBaseUrl, endpointPath)
  const requestPayload = {
    CardNo: memberNumber,
    CardType: getNhiaCardType(memberNumber, payload.cardType || payload.card_type),
  }
  logNhiaConfigEvent('ccc generation settings', {
    mode: settings.mode || 'ONLINE_CLOUD',
    endpoint: 'nhia_configuration',
    configSource: 'cloud_supabase',
    source: 'service_role_readback',
    organizationId,
    branchId: (settings as Record<string, unknown>).branchId || scopedBranchId,
    hasApiKey: settings.hasApiKey,
    hasApiSecret: settings.hasApiSecret,
    apiBaseUrl,
    memberLookupEndpointPath: endpointPath,
    credentialMode: (settings as Record<string, unknown>).credentialMode || (settings as Record<string, unknown>).credential_mode,
  })

  logClaimItBridgeStatus('cc_code.request', { status: 'pending', endpointPath, claimCount: 1 })
  let response: Response
  try {
    const credentialDetails = getScopedNhiaEligibilityCredentials(
      settings as unknown as Record<string, unknown>,
      organizationId,
      scopedBranchId
    )
    console.info('[NHIA CONFIG] eligibility credential source', {
      organizationId,
      branchId: scopedBranchId || '',
      source: credentialDetails.source,
    })
    const headers = buildNhiaEligibilityHeaders(
      settings as unknown as Record<string, unknown>,
      organizationId,
      scopedBranchId
    )
    response = await fetch(finalUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload),
    })
  } catch (error) {
    return {
      ok: false,
      error: `NHIA API request failed: ${getErrorMessage(error)}`,
      receivedKeys,
    }
  }
  const responseText = await response.text()
  let body: unknown = {}
  try {
    body = responseText ? JSON.parse(responseText) : {}
  } catch {
    body = { raw: responseText }
  }

  logClaimItBridgeStatus('cc_code.response', {
    status: response.ok ? 'success' : 'failed',
    httpStatus: response.status,
    endpointPath,
    claimCount: 1,
  })

  if (!response.ok) {
    return {
      ok: false,
      error: getErrorMessage(buildRemoteHttpError('NHIA API', response.status, body)),
      httpStatus: response.status,
      receivedKeys,
      response: body,
    }
  }

  const memberDetails = mapNhiaMemberLookupResponse(body)
  const ccCode = memberDetails?.ccCode || ''
  if (!ccCode) {
    const failureMessage = getNhiaMemberLookupFailureMessage(memberDetails)
    if (failureMessage) {
      return {
        ok: true,
        ccCode: '',
        source: 'api',
        memberDetails,
        eligibilityError: failureMessage,
        response: body,
        receivedKeys,
      }
    }
    return { status: 'pending', source: 'pending', message: 'Pending CLAIM-it validation', response: body }
  }
  if (ccCode.length !== 5) {
    return {
      ok: false,
      error: 'NHIA API returned a CCC/CC code that is not exactly 5 digits.',
      receivedKeys,
      response: body,
    }
  }

  return { ok: true, ccCode, source: 'api', memberDetails, response: body }
}

const buildNhisClaimNumber = () => {
  const stamp = Date.now().toString(36).toUpperCase()
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase()
  return `PHC-${stamp}-${suffix}`
}

const priceNhisClaimMedicinesFromCatalog = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  medicines: Record<string, unknown>[]
) => {
  const catalogRows = await loadNhisDrugCatalogRows(adminClient, organizationId)
  const lookups = buildNhisCatalogLookups(catalogRows)
  const lookupsById = new Map<string, NhisCatalogLookup>()
  const lookupsByCode = new Map<string, NhisCatalogLookup>()
  for (const lookup of lookups) {
    const id = normalizeText(lookup.row.id)
    if (id) lookupsById.set(id, lookup)
    lookupsByCode.set(lookup.code, lookup)
  }

  if (lookups.length === 0) {
    throw new Error('No active NHIS medicine catalog is configured for this organization.')
  }

  return medicines.map((medicine, index) => {
    const requestedId = normalizeText(medicine.nhisDrugId || medicine.nhis_drug_id)
    const requestedCode = normalizeText(
      medicine.nhiaCode || medicine.nhisCode || medicine.drugCode || medicine.code || medicine.drug_code
    ).toUpperCase()
    const lookup = (requestedId && lookupsById.get(requestedId)) ||
      (requestedCode && lookupsByCode.get(requestedCode))

    if (!lookup) {
      throw new Error(`Medicine ${index + 1} must match an active NHIS catalog item.`)
    }

    const unitPrice = parseNonNegativeNumber(
      lookup.unitPrice,
      `Medicine ${index + 1} catalog price`
    )
    const quantity = parseNonNegativeNumber(
      medicine.quantity ?? medicine.dispensedQty ?? medicine.dispensed_qty,
      `Medicine ${index + 1} quantity`
    )
    const totalPrice = Number((unitPrice * quantity).toFixed(2))

    return {
      ...medicine,
      nhisDrugId: normalizeText(lookup.row.id),
      nhiaCode: lookup.code,
      code: lookup.code,
      name: lookup.description,
      unit: lookup.unit,
      unitPrice,
      quantity,
      totalPrice,
    }
  })
}

const submitNhisPharmacyClaim = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireClaimsAccess(requesterProfile, 'Only claims staff can submit NHIS pharmacy claims.')
  await requireTierFeature(adminClient, organizationId, 'claims')

  const claimData = (payload.claimData || payload) as Record<string, unknown>
  const patientName = assertRequiredText(claimData.patientName, 'Patient name')
  const memberNumber = assertRequiredText(claimData.memberNumber, 'Member number')
  const isHospital = normalizeOrganizationType(claimData.organizationType) === 'hospital'
  const diagnosis = normalizeText(claimData.diagnosis) || null
  if (isHospital && !diagnosis) {
    throw new Error('Diagnosis is required for hospital claims.')
  }
  const requestedMedicines = Array.isArray(claimData.medicines) ? claimData.medicines as Record<string, unknown>[] : []
  if (!requestedMedicines.length) {
    throw new Error('At least one medicine is required.')
  }
  const medicines = await priceNhisClaimMedicinesFromCatalog(adminClient, organizationId, requestedMedicines)
  const services = isHospital && Array.isArray(claimData.services) ? claimData.services as Record<string, unknown>[] : []

  const serviceDate = normalizeNhiaServiceDate(claimData.dispensingDate || claimData.serviceDate) || toNhisCalendarDate()
  const medicinesTotal = medicines.reduce((sum, m) => sum + Number(m.totalPrice || 0), 0)
  const servicesTotal = services.reduce((sum, s) => sum + Number(s.totalAmount || s.total_amount || 0), 0)
  const totalAmount = medicinesTotal + servicesTotal
  const hin = normalizeText(claimData.hin)

  const settings = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, true)

  // Generate CC code via CLAIM-it if not provided and API is enabled.
  let ccCode = normalizeText(claimData.ccCode) || null
  let ccSource = 'manual'
  if (!ccCode && settings?.directApiEnabled && settings.apiBaseUrl) {
    const ccResult = await generateNhiaCcCode(adminClient, requesterProfile, organizationId, {
      claimId: `pre-${Date.now()}`,
      patientName,
      memberNumber,
      hin,
      diagnosis,
      serviceDate,
      totalAmount,
      organizationType: normalizeOrganizationType(claimData.organizationType),
    })
    if (ccResult.ok && ccResult.ccCode) {
      ccCode = String(ccResult.ccCode)
      ccSource = String(ccResult.source || 'api')
    }
  }

  // Persist claim to nhis_claims.
  const claimNumber = buildNhisClaimNumber()
  const nameParts = patientName.split(' ')
  const surname = nameParts.slice(-1)[0]
  const otherNames = nameParts.slice(0, -1).join(' ') || patientName

  const { data: claimRow, error: claimError } = await adminClient
    .from('nhis_claims')
    .insert([{
      organization_id: organizationId,
      branch_id: requesterProfile.branch_id || null,
      claim_number: claimNumber,
      member_no: memberNumber,
      hin: hin || null,
      surname,
      other_names: otherNames,
      gender: normalizeText(claimData.gender) || null,
      date_of_birth: normalizeText(claimData.dateOfBirth) || null,
      ccc_no: ccCode || null,
      // Diagnosis only applies to hospital claims; community pharmacies leave it null.
      diagnosis: isHospital ? diagnosis : null,
      service_date: serviceDate,
      service_date_from: serviceDate,
      service_date_to: serviceDate,
      referring_facility: normalizeText(claimData.referralFacility) || null,
      total_amount: totalAmount,
      status: 'served',
      submitted_by: requesterProfile.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }])
    .select('*')
    .single()

  if (claimError) throw claimError

  // Persist medicine lines (both hospital and community pharmacy).
  const medicineRows = medicines.map((m) => ({
    claim_id: claimRow.id,
    organization_id: organizationId,
    nhis_drug_id: normalizeText(m.nhisDrugId) || null,
    drug_code: normalizeText(m.nhiaCode || m.code) || null,
    description: normalizeText(m.name),
    unit: normalizeText(m.unit) || 'tablet',
    unit_price: Number(m.unitPrice || 0),
    dispensed_qty: Number(m.quantity || 0),
    dispensary_date: serviceDate,
    total_amount: Number(m.totalPrice || 0),
    dose: normalizeText(m.dose) || null,
    frequency: normalizeText(m.frequency) || null,
    duration: normalizeText(m.duration) || null,
  }))

  const { error: medicineError } = await adminClient.from('nhis_claim_medicines').insert(medicineRows)
  if (medicineError) throw medicineError

  // Persist G-DRG service lines for hospital claims only.
  if (isHospital && services.length > 0) {
    const serviceRows = services.map((s) => ({
      claim_id: claimRow.id,
      gdrg_code: normalizeText(s.gdrgCode || s.gdrg_code),
      description: normalizeText(s.description),
      age_band: normalizeText(s.ageBand || s.age_band) || null,
      unit_price: Number(s.unitPrice || s.unit_price || 0),
      quantity: Number(s.quantity || 1),
      total_amount: Number(s.totalAmount || s.total_amount || 0),
      facility_group: normalizeText(s.facilityGroup || s.facility_group) || null,
      catering_option: normalizeText(s.cateringOption || s.catering_option) || null,
      mdc: normalizeText(s.mdc) || null,
      service_date: serviceDate,
    }))

    const { error: serviceError } = await adminClient.from('nhis_claim_services').insert(serviceRows)
    if (serviceError) throw serviceError
  }

  // Submit to CLAIM-it if API is configured.
  let claimItResponse: unknown = null
  let submissionStatus = 'served'
  if (settings?.directApiEnabled && settings.apiBaseUrl) {
    const claimEndpointPath = getClaimSubmitEndpointPath(settings as unknown as Record<string, unknown>)
    if (claimEndpointPath) {
      const submissionPayload = {
        claimNumber,
        facilityCode: settings.facilityCode,
        providerNumber: settings.providerNumber,
        schemeName: settings.schemeName || 'National Health Insurance',
        providerTypeDescription: settings.providerTypeDescription,
        providerClassLevel: settings.providerClassLevel,
        claimsOfficerName: normalizeText(claimData.claimsOfficerName) || settings.claimsOfficerName,
        organizationType: isHospital ? 'hospital' : 'pharmacy',
        patient: { name: patientName, memberNumber, hin },
        ccCode,
        diagnosis: isHospital ? diagnosis : null,
        serviceDate,
        totalAmount,
        items: medicines.map((m) => ({
          code: normalizeText(m.nhiaCode || m.code),
          name: normalizeText(m.name),
          quantity: Number(m.quantity),
          unitPrice: Number(m.unitPrice),
          totalPrice: Number(m.totalPrice),
        })),
        ...(isHospital && services.length > 0 ? {
          services: services.map((s) => ({
            gdrgCode: normalizeText(s.gdrgCode || s.gdrg_code),
            description: normalizeText(s.description),
            ageBand: normalizeText(s.ageBand || s.age_band) || null,
            unitPrice: Number(s.unitPrice || s.unit_price || 0),
            quantity: Number(s.quantity || 1),
            totalAmount: Number(s.totalAmount || s.total_amount || 0),
            facilityGroup: normalizeText(s.facilityGroup || s.facility_group) || null,
            cateringOption: normalizeText(s.cateringOption || s.catering_option) || null,
            mdc: normalizeText(s.mdc) || null,
          })),
        } : {}),
      }

      try {
        const response = await fetch(joinUrl(getClaimSubmitBaseUrl(settings as unknown as Record<string, unknown>), claimEndpointPath), {
          method: 'POST',
          headers: await buildNhiaSubmissionHeaders(settings as unknown as Record<string, unknown>),
          body: JSON.stringify(submissionPayload),
        })
        const responseText = await response.text()
        try {
          claimItResponse = responseText ? JSON.parse(responseText) : {}
        } catch {
          claimItResponse = { raw: responseText }
        }

        // CLAIM-it API v1.0.0: { passedClaims, failedClaims, savedClaims, success }
        const claimItBody = claimItResponse as Record<string, unknown> | null
        const savedClaims = Number(claimItBody?.savedClaims ?? -1)
        const failedClaims = Number(claimItBody?.failedClaims ?? 0)
        if (response.ok && (savedClaims > 0 || claimItBody?.success === true)) {
          submissionStatus = 'submitted'
        } else if (failedClaims > 0 || claimItBody?.failed === true) {
          submissionStatus = 'rejected'
        } else {
          submissionStatus = response.ok ? 'submitted' : 'served'
        }
        const { error: updateError } = await adminClient
          .from('nhis_claims')
          .update({
            status: submissionStatus,
            updated_at: new Date().toISOString(),
          })
          .eq('id', claimRow.id)

        if (updateError) console.warn('tier-access nhis claim status update warning:', updateError.message)
      } catch (error) {
        console.warn('tier-access CLAIM-it submission warning:', getErrorMessage(error))
      }
    }
  }

  await tryWriteTierAuditEvent(adminClient, requesterProfile, organizationId, {
    eventType: 'nhis_claim.submitted',
    entityType: 'nhis_claims',
    entityId: claimRow.id,
    action: 'create',
    details: {
      claim_number: claimNumber,
      member_number: memberNumber,
      total_amount: totalAmount,
      medicine_count: medicines.length,
      cc_code: ccCode,
      cc_source: ccSource,
      submission_status: submissionStatus,
    },
  })

  return {
    claim: { ...claimRow, status: submissionStatus, ccc_no: ccCode },
    claimNumber,
    ccCode,
    ccSource,
    submissionStatus,
    claimItResponse,
  }
}

const submitNhiaClaimsDirect = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireClaimsAccess(requesterProfile, 'Only claims staff can submit NHIA claims.')
  const scopedBranchId = resolveScopedBranchId(requesterProfile, payload)
  const settings = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, true, scopedBranchId)
  if (!settings?.directApiEnabled || !settings.apiBaseUrl) {
    throw new Error('Direct NHIA API is not configured. Export a claim batch instead.')
  }

  const claimPayload = payload.payload
  if (!claimPayload || typeof claimPayload !== 'object') {
    throw new Error('Direct NHIA submission requires a claim payload.')
  }

  const expectedFacilityCode = normalizeText(settings.facilityCode)
  const expectedProviderNumber = normalizeText(settings.providerNumber || settings.providerId)
  const identityScopes = [
    claimPayload,
    (claimPayload as Record<string, unknown>).batch,
    (claimPayload as Record<string, unknown>).facility,
    (claimPayload as Record<string, unknown>).provider,
  ].filter((scope): scope is Record<string, unknown> => Boolean(scope && typeof scope === 'object'))
  for (const scope of identityScopes) {
    const payloadFacilityCode = normalizeText(scope.facilityCode || scope.facility_code)
    const payloadProviderNumber = normalizeText(
      scope.providerNumber || scope.provider_number || scope.providerId || scope.provider_id
    )
    if (payloadFacilityCode && expectedFacilityCode && payloadFacilityCode !== expectedFacilityCode) {
      throw new Error('Claim payload facility code does not match the saved facility configuration.')
    }
    if (payloadProviderNumber && expectedProviderNumber && payloadProviderNumber !== expectedProviderNumber) {
      throw new Error('Claim payload provider ID does not match the saved facility configuration.')
    }
  }

  const endpointPath = normalizeText(settings.claimEndpointPath)
  if (!endpointPath) {
    throw new Error('NHIA claim submission endpoint is not configured. Enter the official endpoint path from NHIA/CLAIM-it.')
  }
  const contentType = normalizeText(payload.contentType) || 'application/json'
  const requestBody = normalizeText(payload.payloadContent) || JSON.stringify(claimPayload)
  await validateClaimItBridgePayload(settings as unknown as Record<string, unknown>, requestBody, contentType)
  const response = await fetch(joinUrl(getClaimSubmitBaseUrl(settings as unknown as Record<string, unknown>), endpointPath), {
    method: 'POST',
    headers: await buildNhiaSubmissionHeaders(settings as unknown as Record<string, unknown>, contentType),
    body: requestBody,
  })
  const responseText = await response.text()
  let responseBody: unknown = {}
  try {
    responseBody = responseText ? JSON.parse(responseText) : {}
  } catch {
    responseBody = { raw: responseText }
  }

  if (!response.ok) {
    throw buildRemoteHttpError('NHIA API', response.status, responseBody)
  }

  return {
    source: 'hosted',
    httpStatus: response.status,
    response: responseBody,
    claimIds: Array.isArray(payload.claimIds) ? payload.claimIds : [],
    action: normalizeText(payload.submissionAction) || 'nhis.direct_submit',
  }
}

const toDateOnly = (value: string) => normalizeNhiaServiceDate(value) || toNhisCalendarDate(value)

const getReportNhisAggregate = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  startDate: string,
  endDate: string
) => {
  const monthly = new Map<string, Record<string, number | string>>()
  let offset = 0
  let count = 0
  let totalAmount = 0
  let approved = 0
  let rejected = 0

  while (true) {
    let query = adminClient
      .from('nhis_claims')
      .select('id, status, total_amount, service_date_from, submission_month, created_at')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .range(offset, offset + REPORT_AGGREGATE_PAGE_SIZE - 1)

    if (startDate) query = query.gte('service_date_from', startDate)
    if (endDate) query = query.lte('service_date_from', endDate)

    const { data, error } = await query
    if (error) throw error

    const rows = data || []
    rows.forEach((row) => {
      const status = normalizeText(row.status).toLowerCase()
      const amount = Number.parseFloat(String(row.total_amount || 0))
      const monthSource =
        normalizeText(row.submission_month) ||
        normalizeNhiaServiceDate(row.service_date_from || row.created_at)
      const month = monthSource.slice(0, 7) || 'Unspecified'
      const current = monthly.get(month) || {
        month,
        count: 0,
        totalAmount: 0,
        accepted: 0,
        rejected: 0,
        pending: 0,
      }

      count += 1
      totalAmount += amount
      current.count = Number(current.count) + 1
      current.totalAmount = Number(current.totalAmount) + amount
      if (['accepted', 'approved', 'paid'].includes(status)) {
        approved += 1
        current.accepted = Number(current.accepted) + 1
      } else if (['rejected', 'failed'].includes(status)) {
        rejected += 1
        current.rejected = Number(current.rejected) + 1
      } else {
        current.pending = Number(current.pending) + 1
      }
      monthly.set(month, current)
    })

    if (rows.length < REPORT_AGGREGATE_PAGE_SIZE) break
    offset += REPORT_AGGREGATE_PAGE_SIZE
  }

  return {
    count,
    totalAmount,
    approved,
    rejected,
    monthly: Array.from(monthly.values()).sort((a, b) =>
      String(b.month).localeCompare(String(a.month))
    ),
  }
}

const attachNhisClaimLines = async (
  adminClient: ReturnType<typeof createAdminClient>,
  claims: Record<string, unknown>[]
) => {
  const claimIds = claims.map((claim) => normalizeText(claim.id)).filter(Boolean)
  if (!claimIds.length) return claims

  const [medicinesResult, servicesResult] = await Promise.all([
    adminClient.from('nhis_claim_medicines').select('*').in('claim_id', claimIds),
    adminClient.from('nhis_claim_services').select('*').in('claim_id', claimIds),
  ])
  if (medicinesResult.error) throw medicinesResult.error
  if (servicesResult.error) throw servicesResult.error

  const medicinesByClaim = (medicinesResult.data || []).reduce<Record<string, unknown[]>>((acc, row) => {
    const claimId = normalizeText(row.claim_id)
    if (!claimId) return acc
    if (!acc[claimId]) acc[claimId] = []
    acc[claimId].push(row)
    return acc
  }, {})
  const servicesByClaim = (servicesResult.data || []).reduce<Record<string, unknown[]>>((acc, row) => {
    const claimId = normalizeText(row.claim_id)
    if (!claimId) return acc
    if (!acc[claimId]) acc[claimId] = []
    acc[claimId].push(row)
    return acc
  }, {})

  return claims.map((claim) => {
    const claimId = normalizeText(claim.id)
    return {
      ...claim,
      nhis_claim_medicines: medicinesByClaim[claimId] || [],
      nhis_claim_services: servicesByClaim[claimId] || [],
    }
  })
}

const getReportNhisPage = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireReportsAccess(requesterProfile, 'Only report staff can access NHIS reports.')

  const startDate = normalizeText(payload.startDate)
  const endDate = normalizeText(payload.endDate)
  const offset = Math.max(0, Math.floor(Number(payload.offset) || 0))
  const limit = clampPositiveInteger(
    payload.limit,
    REPORT_BUNDLE_DEFAULT_NHIS_CLAIMS,
    REPORT_BUNDLE_MAX_NHIS_CLAIMS
  )

  let query = adminClient
    .from('nhis_claims')
    .select('*', { count: 'exact' })
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (startDate) query = query.gte('service_date_from', startDate)
  if (endDate) query = query.lte('service_date_from', endDate)

  const { data, error, count } = await query
  if (error) throw error

  const nhisClaims = await attachNhisClaimLines(
    adminClient,
    (data || []) as Record<string, unknown>[]
  )
  const total = count || 0

  return {
    nhisClaims,
    pagination: {
      offset,
      limit,
      total,
      hasMore: offset + nhisClaims.length < total,
    },
  }
}

const getReportBundle = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>,
  includeClaims: boolean
) => {
  requireReportsAccess(requesterProfile, 'Only report staff can access reports.')

  const startDate = normalizeText(payload.startDate)
  const endDate = normalizeText(payload.endDate)
  const drugSearchTerm = toIlikeSearchTerm(payload.drug)
  const reportLimit = clampPositiveInteger(payload.limit, REPORT_BUNDLE_MAX_ROWS, REPORT_BUNDLE_MAX_ROWS)
  const nhisClaimLimit = clampPositiveInteger(
    payload.nhisClaimLimit,
    REPORT_BUNDLE_DEFAULT_NHIS_CLAIMS,
    REPORT_BUNDLE_MAX_NHIS_CLAIMS
  )

  let salesQuery = adminClient
    .from('sales')
    .select(SALES_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .order('sale_date', { ascending: false })
    .limit(reportLimit)

  let claimsQuery = adminClient
    .from('claims')
    .select(CLAIM_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .order('submitted_at', { ascending: false })
    .limit(reportLimit)

  if (startDate) {
    salesQuery = salesQuery.gte('sale_date', `${startDate}T00:00:00`)
    claimsQuery = claimsQuery.gte('service_date', startDate)
  }

  if (endDate) {
    salesQuery = salesQuery.lte('sale_date', `${endDate}T23:59:59`)
    claimsQuery = claimsQuery.lte('service_date', endDate)
  }

  if (drugSearchTerm.length >= 3) {
    const drugNamePattern = `%${drugSearchTerm}%`
    const { data: matchingDrugs } = await adminClient
      .from('drugs')
      .select('id')
      .eq('organization_id', organizationId)
      .ilike('name', drugNamePattern)
      .limit(500)

    const matchingDrugIds = (matchingDrugs || []).map((d) => normalizeText(d.id)).filter(Boolean)

    if (matchingDrugIds.length > 0) {
      const { data: matchingSaleItems } = await adminClient
        .from('sale_items')
        .select('sale_id')
        .in('drug_id', matchingDrugIds)
        .limit(reportLimit)

      const matchingSaleIds = Array.from(new Set((matchingSaleItems || []).map((row) => normalizeText(row.sale_id)).filter(Boolean)))

      if (matchingSaleIds.length > 0) {
        salesQuery = salesQuery.in('id', matchingSaleIds)
      } else {
        salesQuery = salesQuery.in('id', ['00000000-0000-0000-0000-000000000000'])
      }
    } else {
      salesQuery = salesQuery.in('id', ['00000000-0000-0000-0000-000000000000'])
    }
  }

  const [
    { data: sales, error: salesError },
    { data: claims, error: claimsError },
    { data: patients, error: patientsError },
    { data: activeDrugs, error: activeDrugsError },
    { data: allDrugs, error: allDrugsError },
  ] = await Promise.all([
    salesQuery,
    includeClaims ? claimsQuery : Promise.resolve({ data: [], error: null }),
    adminClient
      .from('patients')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(reportLimit),
    adminClient
      .from('drugs')
      .select(REPORT_DRUG_SELECT_FIELDS)
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .or(`batch_number.is.null,batch_number.not.ilike.${DEFAULT_MEDICATION_BATCH_PREFIX}%,quantity.gt.0`)
      .order('created_at', { ascending: false })
      .limit(reportLimit),
    adminClient
      .from('drugs')
      .select(REPORT_DRUG_SELECT_FIELDS)
      .eq('organization_id', organizationId)
      .or(`batch_number.is.null,batch_number.not.ilike.${DEFAULT_MEDICATION_BATCH_PREFIX}%,quantity.gt.0`)
      .limit(reportLimit),
  ])

  if (salesError) throw salesError
  if (claimsError) throw claimsError
  if (patientsError) throw patientsError
  if (activeDrugsError) throw activeDrugsError
  if (allDrugsError) throw allDrugsError

  const salesRows = sales || []
  const claimRows = claims || []
  const patientRows = patients || []
  const activeDrugRows = activeDrugs || []
  const allDrugRows = allDrugs || []
  const reportVisibleActiveDrugRows = activeDrugRows.filter(
    (drug) => !isDefaultMedicationBatchNumber(drug.batch_number) || Number(drug.quantity || 0) > 0
  )
  const reportVisibleAllDrugRows = allDrugRows.filter(
    (drug) => !isDefaultMedicationBatchNumber(drug.batch_number) || Number(drug.quantity || 0) > 0
  )

  const now = new Date()
  const thirtyDaysAhead = new Date(now)
  thirtyDaysAhead.setDate(thirtyDaysAhead.getDate() + 30)

  const lowStock = reportVisibleActiveDrugRows.filter(
    (drug) => Number(drug.quantity || 0) <= Number(drug.reorder_level || 0)
  )
  const expired = reportVisibleAllDrugRows.filter(
    (drug) => new Date(drug.expiry_date).getTime() < now.getTime()
  )
  const expiring = reportVisibleActiveDrugRows.filter((drug) => {
    const expiryTime = new Date(drug.expiry_date).getTime()
    return expiryTime >= now.getTime() && expiryTime <= thirtyDaysAhead.getTime()
  })

  const dailySales = salesRows.reduce<Record<string, number>>((acc, sale) => {
    const key = toDateOnly(String(sale.sale_date))
    acc[key] = (acc[key] || 0) + Number.parseFloat(String(sale.net_amount || 0))
    return acc
  }, {})

  const [
    nhisClaimsResult,
    nhisAggregateResult,
    purchasesResult,
    suppliersResult,
    exportHistoryResult,
    submissionLogsResult,
  ] = await Promise.allSettled([
    adminClient
      .from('nhis_claims')
      .select('*', { count: 'exact' })
      .eq('organization_id', organizationId)
      .gte('service_date_from', startDate || '1900-01-01')
      .lte('service_date_from', endDate || '2999-12-31')
      .order('created_at', { ascending: false })
      .limit(nhisClaimLimit),
    getReportNhisAggregate(adminClient, organizationId, startDate, endDate),
    adminClient
      .from('purchases')
      .select('*, purchase_items (*)')
      .eq('organization_id', organizationId)
      .gte('purchase_date', startDate || '1900-01-01')
      .lte('purchase_date', endDate || '2999-12-31')
      .order('purchase_date', { ascending: false })
      .limit(reportLimit),
    adminClient
      .from('suppliers')
      .select('*')
      .eq('organization_id', organizationId)
      .order('name', { ascending: true })
      .limit(reportLimit),
    adminClient
      .from('nhia_claim_batches')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(reportLimit),
    adminClient
      .from('nhia_submission_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200),
  ])

  const getOptionalRows = (result: PromiseSettledResult<unknown>) => {
    if (result.status !== 'fulfilled') {
      return []
    }

    const value = result.value as { data?: unknown[] | null; error?: unknown }
    if (value.error) return []
    return value.data || []
  }

  const nhisClaimsResponse =
    nhisClaimsResult.status === 'fulfilled'
      ? nhisClaimsResult.value as { data: unknown[] | null; error: unknown; count: number | null }
      : null
  let nhisClaims =
    nhisClaimsResponse && !nhisClaimsResponse.error
      ? (nhisClaimsResponse.data || []) as Record<string, unknown>[]
      : []
  const nhisAggregate =
    nhisAggregateResult.status === 'fulfilled'
      ? nhisAggregateResult.value as Awaited<ReturnType<typeof getReportNhisAggregate>>
      : {
          count: nhisClaims.length,
          totalAmount: nhisClaims.reduce(
            (sum, claim) => sum + Number.parseFloat(String(claim.total_amount || 0)),
            0
          ),
          approved: 0,
          rejected: 0,
          monthly: [],
        }
  const nhisTotal =
    nhisClaimsResponse
      ? Number(nhisClaimsResponse.count || nhisAggregate.count)
      : nhisAggregate.count
  const purchases = getOptionalRows(purchasesResult)
  const suppliers = getOptionalRows(suppliersResult)
  const exportHistory = getOptionalRows(exportHistoryResult)
  const submissionLogs = getOptionalRows(submissionLogsResult)

  if (drugSearchTerm.length >= 3) {
    const medicinePattern = `%${drugSearchTerm}%`
    const { data: matchingMedicines } = await adminClient
      .from('nhis_claim_medicines')
      .select('claim_id')
      .or(`description.ilike.${medicinePattern},drug_code.ilike.${medicinePattern}`)
      .limit(nhisClaimLimit)

    const matchingClaimIds = Array.from(
      new Set((matchingMedicines || []).map((row) => normalizeText(row.claim_id)).filter(Boolean))
    )
    const loadedClaimIds = new Set(nhisClaims.map((claim) => normalizeText(claim.id)).filter(Boolean))
    const missingClaimIds = matchingClaimIds.filter((claimId) => !loadedClaimIds.has(claimId))

    if (missingClaimIds.length) {
      let matchingClaimsQuery = adminClient
        .from('nhis_claims')
        .select('*')
        .eq('organization_id', organizationId)
        .in('id', missingClaimIds)
        .order('created_at', { ascending: false })
        .limit(nhisClaimLimit)

      if (startDate) {
        matchingClaimsQuery = matchingClaimsQuery.gte('service_date_from', startDate)
      }

      if (endDate) {
        matchingClaimsQuery = matchingClaimsQuery.lte('service_date_from', endDate)
      }

      const { data: matchingClaims } = await matchingClaimsQuery
      nhisClaims = [...nhisClaims, ...((matchingClaims || []) as Record<string, unknown>[])]
    }
  }

  nhisClaims = await attachNhisClaimLines(adminClient, nhisClaims)
  const monthlyNhisSubmission = nhisAggregate.monthly

  return {
    sales: salesRows,
    claims: claimRows,
    nhisClaims,
    lowStock,
    expired,
    expiring,
    patients: patientRows,
    drugs: reportVisibleActiveDrugRows,
    purchases,
    suppliers,
    exportHistory,
    submissionLogs,
    monthlyNhisSubmission,
    pagination: {
      nhisClaims: {
        offset: 0,
        limit: nhisClaimLimit,
        total: nhisTotal,
        hasMore: nhisClaims.length < nhisTotal,
      },
    },
    staffActivity: [
      ...submissionLogs.map((log) => ({
        ...(log as Record<string, unknown>),
        module: 'NHIS',
      })),
      ...salesRows.map((sale) => ({
        id: sale.id,
        action: 'sale.completed',
        status: sale.payment_status,
        userId: sale.sold_by,
        module: 'Sales',
        createdAt: sale.sale_date,
        details: sale.sale_number,
      })),
    ],
    metrics: {
      salesCount: salesRows.length,
      salesAmount: salesRows.reduce(
        (sum, sale) => sum + Number.parseFloat(String(sale.net_amount || 0)),
        0
      ),
      soldLineItems: salesRows.reduce((sum, sale) => sum + (sale.sale_items?.length || 0), 0),
      unitsSold: salesRows.reduce(
        (sum, sale) =>
          sum +
          (sale.sale_items || []).reduce(
            (itemSum: number, item: Record<string, unknown>) =>
              itemSum + Number.parseFloat(String(item.quantity || 0)),
            0
          ),
        0
      ),
      claimsCount: claimRows.length,
      nhisClaimsCount: nhisAggregate.count,
      nhisClaimsAmount: nhisAggregate.totalAmount,
      approvedClaims: claimRows.filter((claim) => claim.claim_status === 'approved').length,
      rejectedClaims: claimRows.filter((claim) => claim.claim_status === 'rejected').length,
      approvedNhisClaims: nhisAggregate.approved,
      rejectedNhisClaims: nhisAggregate.rejected,
      lowStockCount: lowStock.length,
      expiredCount: expired.length,
      expiringCount: expiring.length,
      patientCount: patientRows.length,
      inventoryCount: reportVisibleActiveDrugRows.length,
      purchasesCount: purchases.length,
      purchaseAmount: purchases.reduce(
        (sum, purchase) => sum + Number.parseFloat(String((purchase as Record<string, unknown>).total_amount || 0)),
        0
      ),
      dailySales,
    },
  }
}

const getReportDrugMatches = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireReportsAccess(requesterProfile, 'Only report staff can access reports.')

  const startDate = normalizeText(payload.startDate)
  const endDate = normalizeText(payload.endDate)
  const drugSearchTerm = toIlikeSearchTerm(payload.drug)
  if (drugSearchTerm.length < 3) {
    return { sales: [], nhisClaims: [] }
  }

  const pattern = `%${drugSearchTerm}%`
  const [{ data: matchingDrugs, error: drugsError }, { data: matchingMedicines, error: medicinesError }] =
    await Promise.all([
      adminClient
        .from('drugs')
        .select('id')
        .eq('organization_id', organizationId)
        .ilike('name', pattern)
        .limit(500),
      adminClient
        .from('nhis_claim_medicines')
        .select('*')
        .or(`description.ilike.${pattern},drug_code.ilike.${pattern}`)
        .limit(500),
    ])

  if (drugsError) throw drugsError
  if (medicinesError) throw medicinesError

  const matchingDrugIds = (matchingDrugs || []).map((row) => normalizeText(row.id)).filter(Boolean)
  const matchingClaimIds = Array.from(
    new Set((matchingMedicines || []).map((row) => normalizeText(row.claim_id)).filter(Boolean))
  )

  let sales: unknown[] = []
  if (matchingDrugIds.length) {
    const { data: matchingSaleItems, error: saleItemsError } = await adminClient
      .from('sale_items')
      .select('sale_id')
      .in('drug_id', matchingDrugIds)
      .limit(500)
    if (saleItemsError) throw saleItemsError

    const saleIds = Array.from(
      new Set((matchingSaleItems || []).map((row) => normalizeText(row.sale_id)).filter(Boolean))
    )
    if (saleIds.length) {
      let salesQuery = adminClient
        .from('sales')
        .select(SALES_SELECT_FIELDS)
        .eq('organization_id', organizationId)
        .in('id', saleIds)
        .order('sale_date', { ascending: false })
      if (startDate) salesQuery = salesQuery.gte('sale_date', `${startDate}T00:00:00`)
      if (endDate) salesQuery = salesQuery.lte('sale_date', `${endDate}T23:59:59`)
      const { data, error } = await salesQuery
      if (error) throw error
      sales = data || []
    }
  }

  let nhisClaims: Record<string, unknown>[] = []
  if (matchingClaimIds.length) {
    let claimsQuery = adminClient
      .from('nhis_claims')
      .select('*')
      .eq('organization_id', organizationId)
      .in('id', matchingClaimIds)
      .order('created_at', { ascending: false })
    if (startDate) claimsQuery = claimsQuery.gte('service_date_from', startDate)
    if (endDate) claimsQuery = claimsQuery.lte('service_date_from', endDate)
    const { data, error } = await claimsQuery
    if (error) throw error

    const medicinesByClaim = (matchingMedicines || []).reduce<Record<string, unknown[]>>((acc, row) => {
      const claimId = normalizeText(row.claim_id)
      if (!claimId) return acc
      if (!acc[claimId]) acc[claimId] = []
      acc[claimId].push(row)
      return acc
    }, {})
    nhisClaims = (data || []).map((claim) => ({
      ...claim,
      nhis_claim_medicines: medicinesByClaim[normalizeText(claim.id)] || [],
      nhis_claim_services: [],
    }))
  }

  return { sales, nhisClaims }
}

const getReportHealth = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string
) => {
  requireReportsAccess(requesterProfile, 'Only report staff can check report health.')

  const startedAt = Date.now()
  const checks = await Promise.all([
    adminClient.from('sales').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    adminClient.from('patients').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    adminClient.from('nhis_claims').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
  ])
  const failed = checks.find((result) => result.error)
  if (failed?.error) throw failed.error

  return {
    ok: true,
    durationMs: Date.now() - startedAt,
    counts: {
      sales: checks[0].count || 0,
      patients: checks[1].count || 0,
      nhisClaims: checks[2].count || 0,
    },
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405)
  }

  let payload: Record<string, unknown> = {}
  let redactedPayload: unknown = {}
  let action = ''

  try {
    payload = (await request.json()) as Record<string, unknown>
    redactedPayload = redactTierAccessBody(payload)
    console.log('[EDGE FUNCTION BODY]', redactedPayload)

    action = normalizeText(payload.action)
    console.log('[TIER ACTION]', payload.action)
    if (!action) {
      return json(
        {
          ok: false,
          action: '',
          error: 'missing action',
          supportedActions: SUPPORTED_TIER_ACCESS_ACTIONS,
          received: redactedPayload,
        },
        400
      )
    }

    const { supabaseUrl, supabaseAnonKey, serviceRoleKey } = getFunctionEnv()
    const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)
    const requesterResult = await requireRequester(
      request,
      adminClient,
      supabaseUrl,
      supabaseAnonKey
    )

    if ('error' in requesterResult) {
      return requesterResult.error
    }

    const requesterProfile = applyRequestedActiveRole(
      requesterResult.requesterProfile,
      payload.activeRole || payload.active_role
    )
    const { organizationId } = requesterResult

    if (action === 'get_drugs') {
      return json({ drugs: await getDrugs(adminClient, requesterProfile, organizationId, payload) })
    }

    if (action === 'get_patients_workspace') {
      requirePatientAccess(requesterProfile, 'Only patient-care staff can access patients.')
      return json(await getPatientWorkspaceData(adminClient, organizationId, {
        page: payload.page,
        pageSize: payload.pageSize || payload.page_size,
        searchTerm: payload.searchTerm || payload.search_term,
      }))
    }

    if (
      action === 'get_claims' ||
      action === 'get_claims_workspace' ||
      action === 'get_recent_claims' ||
      action === 'get_claims_statistics' ||
      action === 'create_claim' ||
      action === 'update_claim' ||
      action === 'approve_claim' ||
      action === 'reject_claim'
    ) {
      await requireTierFeature(adminClient, organizationId, 'claims')

      if (action === 'create_claim') {
        return json(await createClaim(adminClient, requesterProfile, organizationId, payload))
      }

      if (action === 'update_claim') {
        const claimId = assertRequiredText(payload.id, 'Claim id')
        return json(await updateClaim(adminClient, requesterProfile, organizationId, claimId, payload))
      }

      requireClaimsAccess(requesterProfile, 'Only claims staff can access claims.')

      if (action === 'get_claims_workspace') {
        const [claims, patientData, drugs] = await Promise.all([
          getClaims(adminClient, organizationId, payload),
          getPatientWorkspaceData(adminClient, organizationId, { includeVisitStats: false }),
          getDrugs(adminClient, requesterProfile, organizationId, {
            includeCatalog: false,
          }),
        ])

        return json({
          claims,
          statistics: getClaimsStatisticsFromRows(claims),
          ...patientData,
          drugs,
        })
      }

      if (action === 'get_claims') {
        return json({ claims: await getClaims(adminClient, organizationId, payload) })
      }

      if (action === 'get_recent_claims') {
        return json({
          claims: await getClaims(adminClient, organizationId, {
            filters: {
              limit: parsePositiveInteger(payload.limit, 10),
            },
          }),
        })
      }

      if (action === 'get_claims_statistics') {
        return json(await getClaimsStatistics(adminClient, organizationId))
      }

      const claimId = assertRequiredText(payload.id, 'Claim id')
      if (action === 'approve_claim') {
        return json({
          claim: await updateClaimStatus(
            adminClient,
            requesterProfile,
            organizationId,
            claimId,
            'approved',
            payload
          ),
        })
      }

      return json({
        claim: await updateClaimStatus(
          adminClient,
          requesterProfile,
          organizationId,
          claimId,
          'rejected',
          payload
        ),
      })
    }

    if (action === 'get_report_bundle') {
      const tierContext = await requireTierFeature(adminClient, organizationId, 'reports')
      return json(
        await getReportBundle(
          adminClient,
          requesterProfile,
          organizationId,
          payload,
          tierContext.tierLimits.hasClaims
        )
      )
    }

    if (action === 'get_report_health') {
      await requireTierFeature(adminClient, organizationId, 'reports')
      return json(await getReportHealth(adminClient, requesterProfile, organizationId))
    }

    if (action === 'get_report_nhis_page') {
      await requireTierFeature(adminClient, organizationId, 'reports')
      return json(await getReportNhisPage(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'get_report_drug_matches') {
      await requireTierFeature(adminClient, organizationId, 'reports')
      return json(await getReportDrugMatches(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'get_activity_logs') {
      return json(await getActivityLogs(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'create_drug') {
      return json(await createDrug(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'update_drug') {
      return json({
        drug: await updateDrug(adminClient, requesterProfile, organizationId, payload),
      })
    }

    if (action === 'delete_drug') {
      return json({
        drug: await deleteDrug(adminClient, requesterProfile, organizationId, payload),
      })
    }

    if (action === 'bulk_import_drugs') {
      await requireTierFeature(adminClient, organizationId, 'advanced_inventory')
      return json(await bulkImportDrugs(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'sync_nhis_drugs_to_inventory') {
      return json(await syncNhisDrugsToInventory(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'get_nhia_api_settings') {
      return json({
        settings: await getNhiaApiSettings(
          adminClient,
          requesterProfile,
          organizationId,
          false,
          resolveScopedBranchId(requesterProfile, payload)
        ),
      })
    }

    if (action === 'save_nhia_api_settings') {
      return json(await saveNhiaApiSettings(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'remove_nhia_api_credentials') {
      return json(await removeNhiaApiCredentials(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'test_claimit_connection') {
      return json(await testClaimItConnection(adminClient, requesterProfile, organizationId, payload))
    }

    if (NHIA_CC_CODE_ACTIONS.has(action)) {
      return json(await generateNhiaCcCode(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'submit_nhia_claims_direct') {
      return json(await submitNhiaClaimsDirect(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'submit_nhis_pharmacy_claim') {
      return json(await submitNhisPharmacyClaim(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'get_epharmacy_marketplace') {
      return json(await getEpharmacyMarketplace(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'save_epharmacy_profile') {
      return json(await saveEpharmacyProfile(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'update_epharmacy_listing_controls') {
      return json(await updateEpharmacyListingControls(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'create_epharmacy_order') {
      return json(await createEpharmacyOrder(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'update_epharmacy_order_status') {
      return json(await updateEpharmacyOrderStatus(adminClient, requesterProfile, organizationId, payload))
    }

    return json(
      {
        ok: false,
        action,
        error: `Unsupported action: ${action}`,
        supportedActions: SUPPORTED_TIER_ACCESS_ACTIONS,
        received: redactedPayload,
      },
      400
    )
  } catch (error) {
    console.error('tier-access error:', error)
    const nhiaValidation = getNhiaValidationDetails(error)
    return json(
      {
        ok: false,
        action,
        error: getErrorMessage(error),
        ...(nhiaValidation
          ? {
              integrationMode: nhiaValidation.integrationMode,
              missingFields: nhiaValidation.missingFields,
            }
          : {}),
        received: redactedPayload,
      },
      400
    )
  }
})
