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
  patients (full_name, phone, insurance_provider, insurance_id)
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
  supplier,
  category,
  reorder_level,
  status,
  created_at
`

type TierAccessAction =
  | 'get_drugs'
  | 'get_claims'
  | 'get_recent_claims'
  | 'get_claims_statistics'
  | 'create_claim'
  | 'update_claim'
  | 'approve_claim'
  | 'reject_claim'
  | 'get_report_bundle'
  | 'create_drug'
  | 'update_drug'
  | 'delete_drug'
  | 'bulk_import_drugs'
  | 'sync_nhis_drugs_to_inventory'
  | 'get_nhia_api_settings'
  | 'save_nhia_api_settings'
  | 'generate_nhia_cc_code'
  | 'submit_nhia_claims_direct'
  | 'test_claimit_connection'

type RequesterProfile = {
  id: string
  role: string
  organization_id: string | null
  branch_id: string | null
  can_manage_inventory: boolean
  can_view_reports: boolean
  can_manage_claims: boolean
}

const INVENTORY_ROLES = ['admin', 'pharmacist', 'technician', 'procurement', 'branch_manager']
const SALES_ROLES = ['admin', 'pharmacist', 'assistant', 'cashier', 'technician', 'branch_manager']
const CLAIMS_ROLES = ['admin', 'pharmacist', 'billing', 'claims_officer']
const NHIS_ROLES = ['admin', 'pharmacist', 'billing', 'claims_officer']
const REPORT_ROLES = ['admin', 'pharmacist', 'branch_manager']
const NHIA_SETTINGS_ROLES = ['admin', 'pharmacist', 'branch_manager']
// ✅ NHIS PHARMACY LEVEL PATCH START
const VALID_PHARMACY_LEVELS = ['P1', 'P2', 'LCS', 'HP']
const VALID_MEDICINE_ACCESS_LEVELS = ['OTC', 'Prescription', 'Specialist', 'Controlled']
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

const getRequesterProfile = async (
  adminClient: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<RequesterProfile | null> => {
  const { data, error } = await adminClient
    .from('users')
    .select('id, role, organization_id, branch_id, can_manage_inventory, can_view_reports, can_manage_claims')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  return {
    id: data.id,
    role: normalizeText(data.role).toLowerCase(),
    organization_id: normalizeText(data.organization_id) || null,
    branch_id: normalizeText(data.branch_id) || null,
    can_manage_inventory: Boolean(data.can_manage_inventory),
    can_view_reports: Boolean(data.can_view_reports),
    can_manage_claims: Boolean(data.can_manage_claims),
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
  if (
    requesterProfile.role !== 'admin' &&
    !allowedRoles.includes(requesterProfile.role)
  ) {
    throw new Error(message)
  }
}

const requireInventoryAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (!INVENTORY_ROLES.includes(requesterProfile.role) && !requesterProfile.can_manage_inventory) {
    throw new Error(message)
  }
}

const requireClaimsAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (!CLAIMS_ROLES.includes(requesterProfile.role) && !requesterProfile.can_manage_claims) {
    throw new Error(message)
  }
}

const requireNhisCatalogAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !NHIS_ROLES.includes(requesterProfile.role) &&
    !INVENTORY_ROLES.includes(requesterProfile.role) &&
    !requesterProfile.can_manage_inventory &&
    !requesterProfile.can_manage_claims
  ) {
    throw new Error(message)
  }
}

const requireNhiaAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !NHIS_ROLES.includes(requesterProfile.role) &&
    !NHIA_SETTINGS_ROLES.includes(requesterProfile.role) &&
    !requesterProfile.can_manage_claims
  ) {
    throw new Error(message)
  }
}

const requireNhiaSettingsAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (!NHIA_SETTINGS_ROLES.includes(requesterProfile.role) && !requesterProfile.can_manage_claims) {
    throw new Error(message)
  }
}

const requireClaimCreateAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (
    !CLAIMS_ROLES.includes(requesterProfile.role) &&
    !requesterProfile.can_manage_claims &&
    !SALES_ROLES.includes(requesterProfile.role)
  ) {
    throw new Error(message)
  }
}

const requireReportsAccess = (requesterProfile: RequesterProfile, message: string) => {
  if (!REPORT_ROLES.includes(requesterProfile.role) && !requesterProfile.can_view_reports) {
    throw new Error(message)
  }
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
        service_date: normalizeText(claimData.serviceDate) || new Date().toISOString().split('T')[0],
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
    service_date: normalizeText(claimData.serviceDate) || new Date().toISOString().split('T')[0],
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
  requireInventoryAccess(requesterProfile, 'Only inventory staff can add inventory items.')

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
  requireInventoryAccess(requesterProfile, 'Only inventory staff can update inventory items.')

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

  const { data, error } = await adminClient
    .from('drugs')
    .update({
      status: 'inactive',
      updated_at: new Date().toISOString(),
    })
    .eq('id', drugId)
    .eq('organization_id', organizationId)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

const bulkImportDrugs = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireInventoryAccess(requesterProfile, 'Only inventory staff can import inventory items.')

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
    : 'api_key'
}

const normalizeExportFormat = (value: unknown) =>
  normalizeText(value).toLowerCase() === 'xml' ? 'xml' : 'json'

const NHIA_SECRET_MASK = '••••••••••••'
const NHIA_SECRET_FIELDS = new Set(['apiKey', 'apiSecret'])

const maskCredentials = (payload: Record<string, unknown> = {}) =>
  Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, Boolean(normalizeText(value))]))

const mapNhiaSettingsRow = (row: Record<string, unknown> | null, includeCredentials = false) => {
  if (!row) return null
  const credentials = (row.credential_payload && typeof row.credential_payload === 'object'
    ? row.credential_payload
    : {}) as Record<string, unknown>

  return {
    id: row.id,
    organizationId: row.organization_id || '',
    facilityCode: row.facility_code || '',
    providerNumber: row.provider_number || '',
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
    sandboxBaseUrl: row.sandbox_base_url || '',
    productionBaseUrl: row.production_base_url || row.api_base_url || '',
    // ✅ NHIA API ARCHITECTURE PATCH END
    providerTypeDescription: row.provider_type_description || '',
    providerClassLevel: row.provider_class_level || '',
    claimsOfficerName: row.claims_officer_name || '',
    admissionPaymentOption: row.admission_payment_option || 'nhis_pays_admission',
    claimitValidationEnabled: row.claimit_validation_enabled !== false,
    claimsOfficerSignatureUrl: row.claims_officer_signature_url || '',
    submitterId: row.submitter_id || '',
    apiEnvironment: row.api_environment || 'production',
    apiBaseUrl: row.api_base_url || '',
    claimEndpointPath: row.claim_endpoint_path || '',
    claimValidationEndpointPath: row.claim_validation_endpoint_path || '',
    ccCodeEndpointPath: row.cc_code_endpoint_path || '',
    claimStatusEndpointPath: row.claim_status_endpoint_path || '',
    memberLookupEndpointPath: row.member_lookup_endpoint_path || '',
    directApiEnabled: Boolean(row.direct_api_enabled),
    credentialMode: row.credential_mode || 'api_key',
    credentials: includeCredentials ? credentials : {},
    credentialSummary: maskCredentials(credentials),
    hasApiKey: Boolean(normalizeText(credentials.apiKey)),
    hasApiSecret: Boolean(normalizeText(credentials.apiSecret)),
    nhisMemberDigits: Number(row.nhis_member_digits || 8),
    ghanaCardDigits: Number(row.ghana_card_digits || 10),
    exportFormat: row.export_format || 'json',
    maxRetryAttempts: Number(row.max_retry_attempts || 3),
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const getNhiaApiSettings = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  includeCredentials = false
) => {
  requireNhiaAccess(requesterProfile, 'Only NHIS staff can access NHIA API settings.')

  const { data, error } = await adminClient
    .from('organization_nhia_integrations')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  return mapNhiaSettingsRow(data as Record<string, unknown> | null, includeCredentials)
}

const saveNhiaApiSettings = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireNhiaSettingsAccess(requesterProfile, 'Only organization admins can update NHIA API settings.')

  const settings = (payload.settings || {}) as Record<string, unknown>
  const incomingCredentials =
    settings.credentials && typeof settings.credentials === 'object'
      ? (settings.credentials as Record<string, unknown>)
      : {}
  const existing = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, true)
  const credentials = { ...(existing?.credentials || {}) } as Record<string, unknown>

  for (const [key, value] of Object.entries(incomingCredentials)) {
    if (NHIA_SECRET_FIELDS.has(key) && (!normalizeText(value) || normalizeText(value) === NHIA_SECRET_MASK)) continue
    if (normalizeText(value)) credentials[key] = value
  }

  const accreditationExpiryDate = getNhiaAccreditationExpiryDate(settings)
  const claimsOfficerName = normalizeText(settings.claimsOfficerName ?? settings.claims_officer_name)

  const row = {
    organization_id: organizationId,
    facility_code: normalizeText(settings.facilityCode) || null,
    provider_number: normalizeText(settings.providerNumber) || null,
    scheme_name: normalizeText(settings.schemeName) || 'National Health Insurance',
    // ✅ NHIA CONFIG PATCH START
    facility_type: normalizeText(settings.facilityType) || null,
    pharmacy_facility_level: normalizeText(settings.pharmacyFacilityLevel) || null,
    provider_level_code: normalizeText(settings.providerLevelCode) || null,
    credential_code: normalizeText(settings.credentialCode) || normalizeText(settings.facilityCode) || null,
    license_number: normalizeText(settings.licenseNumber) || null,
    accreditation_expiry_date: accreditationExpiryDate || null,
    // ✅ NHIA CONFIG PATCH END
    // ✅ NHIA API ARCHITECTURE PATCH START
    integration_mode: normalizeText(settings.integrationMode) || 'claimit_export',
    connection_profile: normalizeText(settings.connectionProfile || settings.connection_profile) || 'local_server',
    validation_mode: normalizeText(settings.validationMode || settings.validation_mode) || 'validate_before_submit',
    sandbox_base_url: normalizeText(settings.sandboxBaseUrl).replace(/\/+$/, '') || null,
    production_base_url: normalizeText(settings.productionBaseUrl).replace(/\/+$/, '') || null,
    // ✅ NHIA API ARCHITECTURE PATCH END
    provider_type_description: normalizeText(settings.providerTypeDescription) || null,
    provider_class_level: normalizeText(settings.providerClassLevel) || null,
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
          : settings.productionBaseUrl)
    ).replace(/\/+$/, '') || null,
    claim_endpoint_path: normalizeText(settings.claimEndpointPath) || null,
    claim_validation_endpoint_path: normalizeText(settings.claimValidationEndpointPath || settings.claim_validation_endpoint_path) || null,
    cc_code_endpoint_path: normalizeText(settings.ccCodeEndpointPath) || null,
    claim_status_endpoint_path: normalizeText(settings.claimStatusEndpointPath) || null,
    member_lookup_endpoint_path: normalizeText(settings.memberLookupEndpointPath) || null,
    direct_api_enabled: Boolean(settings.directApiEnabled),
    credential_mode: normalizeCredentialMode(settings.credentialMode),
    credential_payload: credentials,
    nhis_member_digits: Number(settings.nhisMemberDigits || 8),
    ghana_card_digits: Number(settings.ghanaCardDigits || 10),
    export_format: normalizeExportFormat(settings.exportFormat),
    max_retry_attempts: Math.min(Math.max(Number(settings.maxRetryAttempts || 3), 1), 10),
    is_active: true,
    updated_by: requesterProfile.id,
    updated_at: new Date().toISOString(),
    ...(existing?.id ? {} : { created_by: requesterProfile.id }),
  }

  const { data, error } = await adminClient
    .from('organization_nhia_integrations')
    .upsert(row, { onConflict: 'organization_id' })
    .select('*')
    .single()

  if (error) throw error
  return { settings: mapNhiaSettingsRow(data as Record<string, unknown>, false) }
}

const joinUrl = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

const fetchClaimItToken = async (settings: Record<string, unknown>) => {
  const credentials = (settings.credentials || {}) as Record<string, unknown>
  const username = assertRequiredText(credentials.username, 'CLAIM-it username')
  const password = assertRequiredText(credentials.password, 'CLAIM-it password')
  const tokenPath = normalizeText(credentials.tokenEndpointPath) || '/token'
  const url = new URL(joinUrl(String(settings.apiBaseUrl), tokenPath))
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
    const username = normalizeText(credentials.username)
    const password = normalizeText(credentials.password)
    if ((username || password) && !headers.Authorization) {
      headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`
    }
  }

  if (mode === 'api_key') {
    const headerName = normalizeText(credentials.headerName) || 'x-api-key'
    const prefix = normalizeText(credentials.headerPrefix)
    const apiKey = normalizeText(credentials.apiKey)
    if (apiKey) headers[headerName] = prefix ? `${prefix} ${apiKey}` : apiKey
    const apiSecret = normalizeText(credentials.apiSecret)
    const secretHeaderName = normalizeText(credentials.secretHeaderName) || 'x-api-secret'
    if (apiSecret) headers[secretHeaderName] = apiSecret
    applyBasicCredentialsHeader()
  } else if (mode === 'bearer_token') {
    const token = normalizeText(credentials.apiKey || credentials.token)
    if (token) headers.Authorization = `Bearer ${token}`
  } else if (mode === 'basic_auth') {
    const username = normalizeText(credentials.username)
    const password = normalizeText(credentials.password)
    if (username || password) headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`
  } else if (mode === 'oauth_client') {
    const token = normalizeText(credentials.accessToken || credentials.token || credentials.apiKey)
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
  if (mode === 'claimit_token') {
    headers.Authorization = `Bearer ${await fetchClaimItToken(settings)}`
  }
  return headers
}

const isClaimItBridgeMode = (settings: Record<string, unknown>) =>
  ['claimit_bridge', 'claimit_assisted'].includes(normalizeText(settings.integrationMode || settings.integration_mode))

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
    if (normalizeText(value) && normalizeText(value) !== NHIA_SECRET_MASK) credentials[key] = value
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
  const baseUrl = normalizeText(settings.apiBaseUrl || settings.api_base_url)
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
    headers: buildNhiaHeaders(settings, 'application/json'),
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

  const response = await fetch(joinUrl(String(settings.apiBaseUrl), endpointPath), {
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
  if (!body || typeof body !== 'object') return ''
  const record = body as Record<string, unknown>
  const direct = normalizeCcCode(record.ccCode || record.cc_code || record.cccNo || record.ccc_no || record.code)
  if (direct) return direct
  return record.data && typeof record.data === 'object' ? extractCcCode(record.data) : ''
}

const generateNhiaCcCode = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  const settings = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, true)
  if (!settings?.directApiEnabled || !settings.apiBaseUrl) {
    throw new Error('Direct NHIA API is not configured. Enter the CCC/CC code manually.')
  }

  const requestPayload = {
    action: 'generate_cc_code',
    facilityCode: settings.facilityCode,
    providerNumber: settings.providerNumber,
    submitterId: settings.submitterId || requesterProfile.id,
    organizationType: normalizeOrganizationType(payload.organizationType || payload.organization_type),
    patient: {
      name: normalizeText(payload.patientName),
      memberNumber: normalizeText(payload.memberNumber || payload.memberNo),
      hin: normalizeText(payload.hin),
    },
    diagnosis: normalizeText(payload.diagnosis),
    serviceDate: normalizeText(payload.serviceDate),
    requestedAt: new Date().toISOString(),
  }

  if (!normalizeText(settings.ccCodeEndpointPath)) {
    throw new Error('NHIA CCC/CC code endpoint is not configured. Enter the official endpoint path from NHIA/CLAIM-it.')
  }

  const response = await fetch(joinUrl(String(settings.apiBaseUrl), String(settings.ccCodeEndpointPath)), {
    method: 'POST',
    headers: await buildNhiaSubmissionHeaders(settings as unknown as Record<string, unknown>),
    body: JSON.stringify(requestPayload),
  })
  const responseText = await response.text()
  let body: unknown = {}
  try {
    body = responseText ? JSON.parse(responseText) : {}
  } catch {
    body = { raw: responseText }
  }

  if (!response.ok) throw new Error(`NHIA API returned HTTP ${response.status}.`)

  const ccCode = extractCcCode(body)
  if (!ccCode) throw new Error('NHIA API response did not include a CCC/CC code.')
  if (ccCode.length !== 5) throw new Error('NHIA API returned a CCC/CC code that is not exactly 5 digits.')

  return { ccCode, source: 'api', response: body }
}

const submitNhiaClaimsDirect = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  const settings = await getNhiaApiSettings(adminClient, requesterProfile, organizationId, true)
  if (!settings?.directApiEnabled || !settings.apiBaseUrl) {
    throw new Error('Direct NHIA API is not configured. Export a claim batch instead.')
  }

  const claimPayload = payload.payload
  if (!claimPayload || typeof claimPayload !== 'object') {
    throw new Error('Direct NHIA submission requires a claim payload.')
  }

  const endpointPath = normalizeText(settings.claimEndpointPath)
  if (!endpointPath) {
    throw new Error('NHIA claim submission endpoint is not configured. Enter the official endpoint path from NHIA/CLAIM-it.')
  }
  const contentType = normalizeText(payload.contentType) || 'application/json'
  const requestBody = normalizeText(payload.payloadContent) || JSON.stringify(claimPayload)
  await validateClaimItBridgePayload(settings as unknown as Record<string, unknown>, requestBody, contentType)
  const response = await fetch(joinUrl(String(settings.apiBaseUrl), endpointPath), {
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
    throw new Error(`NHIA API returned HTTP ${response.status}.`)
  }

  return {
    source: 'hosted',
    httpStatus: response.status,
    response: responseBody,
    claimIds: Array.isArray(payload.claimIds) ? payload.claimIds : [],
    action: normalizeText(payload.submissionAction) || 'nhis.direct_submit',
  }
}

const toDateOnly = (value: string) => new Date(value).toISOString().split('T')[0]

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

  let salesQuery = adminClient
    .from('sales')
    .select(SALES_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .order('sale_date', { ascending: false })

  let claimsQuery = adminClient
    .from('claims')
    .select(CLAIM_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .order('submitted_at', { ascending: false })

  if (startDate) {
    salesQuery = salesQuery.gte('sale_date', `${startDate}T00:00:00`)
    claimsQuery = claimsQuery.gte('service_date', startDate)
  }

  if (endDate) {
    salesQuery = salesQuery.lte('sale_date', `${endDate}T23:59:59`)
    claimsQuery = claimsQuery.lte('service_date', endDate)
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
    adminClient.from('patients').select('*').eq('organization_id', organizationId),
    adminClient
      .from('drugs')
      .select(REPORT_DRUG_SELECT_FIELDS)
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .or(`batch_number.is.null,batch_number.not.ilike.${DEFAULT_MEDICATION_BATCH_PREFIX}%,quantity.gt.0`)
      .order('created_at', { ascending: false }),
    adminClient
      .from('drugs')
      .select(REPORT_DRUG_SELECT_FIELDS)
      .eq('organization_id', organizationId)
      .or(`batch_number.is.null,batch_number.not.ilike.${DEFAULT_MEDICATION_BATCH_PREFIX}%,quantity.gt.0`),
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

  return {
    sales: salesRows,
    claims: claimRows,
    lowStock,
    expired,
    expiring,
    patients: patientRows,
    drugs: reportVisibleActiveDrugRows,
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
      approvedClaims: claimRows.filter((claim) => claim.claim_status === 'approved').length,
      rejectedClaims: claimRows.filter((claim) => claim.claim_status === 'rejected').length,
      lowStockCount: lowStock.length,
      expiredCount: expired.length,
      expiringCount: expiring.length,
      patientCount: patientRows.length,
      inventoryCount: reportVisibleActiveDrugRows.length,
      dailySales,
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

  try {
    const payload = (await request.json()) as Record<string, unknown>
    const action = normalizeText(payload.action) as TierAccessAction
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

    const { requesterProfile, organizationId } = requesterResult

    if (action === 'get_drugs') {
      return json({ drugs: await getDrugs(adminClient, requesterProfile, organizationId, payload) })
    }

    if (
      action === 'get_claims' ||
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
      return json({ settings: await getNhiaApiSettings(adminClient, requesterProfile, organizationId, false) })
    }

    if (action === 'save_nhia_api_settings') {
      return json(await saveNhiaApiSettings(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'test_claimit_connection') {
      return json(await testClaimItConnection(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'generate_nhia_cc_code') {
      return json(await generateNhiaCcCode(adminClient, requesterProfile, organizationId, payload))
    }

    if (action === 'submit_nhia_claims_direct') {
      return json(await submitNhiaClaimsDirect(adminClient, requesterProfile, organizationId, payload))
    }

    return json({ error: 'Unsupported tier access action.' }, 400)
  } catch (error) {
    console.error('tier-access error:', error)
    return json(
      {
        error: getErrorMessage(error),
      },
      400
    )
  }
})
