import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  buildDefaultMedicationRowsForOrganization,
  DEFAULT_MEDICATION_BATCH_PREFIX,
  isDefaultMedicationBatchNumber,
} from '../_shared/defaultMedicationCatalog.ts'
import { resolveTierAccess } from '../_shared/tier.ts'

const USERS_PER_PAGE = 200
const MAX_USER_PAGES = 10
const DRUG_IMPORT_BATCH_SIZE = 50
const CATALOG_SYNC_BATCH_SIZE = 200
const CLAIM_SELECT_FIELDS = `
  *,
  claim_items (*),
  patients (full_name, phone, insurance_provider),
  users:submitted_by (full_name)
`
const SALES_SELECT_FIELDS = `
  *,
  sale_items (
    *,
    drugs (name)
  ),
  patients (full_name)
`

type TierAccessAction =
  | 'get_drugs'
  | 'get_claims'
  | 'get_recent_claims'
  | 'get_claims_statistics'
  | 'create_claim'
  | 'approve_claim'
  | 'reject_claim'
  | 'get_report_bundle'
  | 'create_drug'
  | 'update_drug'
  | 'delete_drug'
  | 'bulk_import_drugs'

type RequesterProfile = {
  id: string
  role: string
  organization_id: string | null
}

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

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
    .select('id, role, organization_id')
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
  }
}

const getOrganizationTierContext = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const { data: organization, error } = await adminClient
    .from('organizations')
    .select('id, status, subscription_tier, trial_ends_at, subscription_ends_at')
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

  if (feature === 'claims' && !tierContext.tierLimits.hasClaims) {
    throw new Error('Insurance claims are available on the Enterprise plan.')
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
  if (!allowedRoles.includes(requesterProfile.role)) {
    throw new Error(message)
  }
}

const getDrugCount = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const { count, error } = await adminClient
    .from('drugs')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .not('batch_number', 'ilike', `${DEFAULT_MEDICATION_BATCH_PREFIX}%`)

  if (error) {
    throw error
  }

  return count || 0
}

const syncDefaultMedicationCatalog = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const { data: existingCatalogRows, error } = await adminClient
    .from('drugs')
    .select('id, organization_id, batch_number, status')
    .ilike('batch_number', `${DEFAULT_MEDICATION_BATCH_PREFIX}%`)

  if (error) {
    throw error
  }

  const currentOrganizationCatalogRows = (existingCatalogRows || []).filter(
    (row) => normalizeText(row.organization_id) === organizationId
  )

  const existingBatchNumbers = new Set(
    currentOrganizationCatalogRows
      .map((row) => normalizeText(row.batch_number).toUpperCase())
      .filter(Boolean)
  )

  const globallyReservedBatchNumbers = new Set(
    (existingCatalogRows || [])
      .map((row) => normalizeText(row.batch_number).toUpperCase())
      .filter(Boolean)
  )

  const claimableCatalogIds = (existingCatalogRows || [])
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

  const missingRows = buildDefaultMedicationRowsForOrganization(organizationId, existingBatchNumbers).filter(
    (row) => !globallyReservedBatchNumbers.has(normalizeText(row.batch_number).toUpperCase())
  )

  for (let index = 0; index < missingRows.length; index += CATALOG_SYNC_BATCH_SIZE) {
    const batch = missingRows.slice(index, index + CATALOG_SYNC_BATCH_SIZE)
    const { error: insertError } = await adminClient.from('drugs').upsert(batch, {
      onConflict: 'organization_id,name,batch_number',
      ignoreDuplicates: true,
    })

    if (insertError) {
      throw insertError
    }
  }
}

const getDrugs = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  try {
    await syncDefaultMedicationCatalog(adminClient, organizationId)
  } catch (error) {
    // Never block core inventory visibility when catalog sync hits legacy-data issues.
    console.error('tier-access catalog sync warning:', error)
  }

  const includeCatalog = Boolean(payload.includeCatalog)
  const { data, error } = await adminClient
    .from('drugs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('name')

  if (error) {
    throw error
  }

  const rows = data || []
  if (includeCatalog) {
    return rows
  }

  return rows.filter(
    (row) => !isDefaultMedicationBatchNumber(row.batch_number) || Number(row.quantity || 0) > 0
  )
}

const assertCanAddDrugs = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  additionalCount: number
) => {
  const tierContext = await getOrganizationTierContext(adminClient, organizationId)
  const maxDrugs = tierContext.tierLimits.maxDrugs
  if (!Number.isFinite(maxDrugs)) {
    return
  }

  const currentCount = await getDrugCount(adminClient, organizationId)
  if (currentCount + additionalCount > maxDrugs) {
    throw new Error(
      `This organization has reached the ${maxDrugs}-drug limit for its ${tierContext.effectiveTier === 'pro' ? 'Professional' : 'Basic'} plan.`
    )
  }
}

const assertCustomBatchNumberAllowed = (batchNumber: string) => {
  if (isDefaultMedicationBatchNumber(batchNumber)) {
    throw new Error(DEFAULT_CATALOG_BATCH_ERROR)
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

  if (filters.startDate) {
    query = query.gte('service_date', String(filters.startDate))
  }

  if (filters.endDate) {
    query = query.lte('service_date', String(filters.endDate))
  }

  if (searchTerm) {
    const escaped = searchTerm.replace(/[%_,]/g, '')
    query = query.or(
      `patient_name.ilike.%${escaped}%,claim_number.ilike.%${escaped}%,insurance_id.ilike.%${escaped}%`
    )
  }

  if (limit > 0) {
    query = query.limit(limit)
  }

  const { data, error } = await query
  if (error) {
    throw error
  }

  return data || []
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
  requireRole(
    requesterProfile,
    ['admin', 'pharmacist'],
    'Only admins and pharmacists can create claims.'
  )

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

const updateClaimStatus = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  claimId: string,
  nextStatus: 'approved' | 'rejected',
  payload: Record<string, unknown>
) => {
  requireRole(
    requesterProfile,
    ['admin', 'pharmacist'],
    'Only admins and pharmacists can update claim status.'
  )

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
  requireRole(
    requesterProfile,
    ['admin', 'pharmacist'],
    'Only admins and pharmacists can add inventory items.'
  )

  await assertCanAddDrugs(adminClient, organizationId, 1)

  const drugData = (payload.drug || {}) as Record<string, unknown>
  const batchNumber = assertRequiredText(drugData.batchNumber, 'Batch number')
  assertCustomBatchNumberAllowed(batchNumber)

  const { data, error } = await adminClient
    .from('drugs')
    .insert([
      {
        organization_id: organizationId,
        name: assertRequiredText(drugData.name, 'Drug name'),
        batch_number: batchNumber,
        expiry_date: assertRequiredText(drugData.expiryDate, 'Expiry date'),
        quantity: parseNonNegativeNumber(drugData.quantity, 'Quantity'),
        price: parseNonNegativeNumber(drugData.price, 'Price'),
        cost_price: parseNonNegativeNumber(drugData.costPrice ?? 0, 'Cost price'),
        supplier: normalizeText(drugData.supplier) || null,
        category: normalizeText(drugData.category) || null,
        description: normalizeText(drugData.description) || null,
        reorder_level: parseNonNegativeNumber(drugData.reorderLevel ?? 10, 'Reorder level'),
        unit: normalizeText(drugData.unit) || 'tablets',
        status: 'active',
      },
    ])
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

const updateDrug = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  requireRole(
    requesterProfile,
    ['admin', 'pharmacist'],
    'Only admins and pharmacists can update inventory items.'
  )

  const drugId = assertRequiredText(payload.drugId, 'Drug ID')
  const existingDrug = await getDrugForOrganization(adminClient, organizationId, drugId)
  const drugData = (payload.drug || {}) as Record<string, unknown>
  const name = assertRequiredText(drugData.name, 'Drug name')
  const batchNumber = assertRequiredText(drugData.batchNumber, 'Batch number')
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
    updatePayload.unit = normalizeText(drugData.unit) || 'tablets'
  }

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
    ['admin', 'pharmacist'],
    'Only admins and pharmacists can remove inventory items.'
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
  requireRole(
    requesterProfile,
    ['admin', 'pharmacist'],
    'Only admins and pharmacists can import inventory items.'
  )

  const drugs = Array.isArray(payload.drugs) ? payload.drugs : []
  if (drugs.length === 0) {
    return {
      successful: [],
      failed: [],
    }
  }

  await assertCanAddDrugs(adminClient, organizationId, drugs.length)

  const results: {
    successful: Array<Record<string, unknown>>
    failed: Array<Record<string, unknown>>
  } = {
    successful: [],
    failed: [],
  }

  const normalizedRows = drugs.map((item) => {
    const row = item as Record<string, unknown>
    const batchNumber = assertRequiredText(row.batch_number, 'Batch number')
    assertCustomBatchNumberAllowed(batchNumber)

    return {
      organization_id: organizationId,
      name: assertRequiredText(row.name, 'Drug name'),
      batch_number: batchNumber,
      expiry_date: assertRequiredText(row.expiry_date, 'Expiry date'),
      quantity: parseNonNegativeNumber(row.quantity, 'Quantity'),
      price: parseNonNegativeNumber(row.price, 'Price'),
      cost_price: parseNonNegativeNumber(row.cost_price ?? 0, 'Cost price'),
      supplier: normalizeText(row.supplier) || null,
      category: normalizeText(row.category) || null,
      description: normalizeText(row.description) || null,
      reorder_level: parseNonNegativeNumber(row.reorder_level ?? 10, 'Reorder level'),
      unit: normalizeText(row.unit) || 'tablets',
      status: normalizeText(row.status) || 'active',
    }
  })

  for (let index = 0; index < normalizedRows.length; index += DRUG_IMPORT_BATCH_SIZE) {
    const batch = normalizedRows.slice(index, index + DRUG_IMPORT_BATCH_SIZE)

    try {
      const { data, error } = await adminClient.from('drugs').insert(batch).select()

      if (error) {
        for (const drug of batch) {
          try {
            const { data: singleData, error: singleError } = await adminClient
              .from('drugs')
              .insert([drug])
              .select()

            if (singleError) {
              results.failed.push({
                drug,
                error: singleError.message,
              })
            } else if (singleData?.[0]) {
              results.successful.push(singleData[0])
            }
          } catch (singleError) {
            results.failed.push({
              drug,
              error: singleError instanceof Error ? singleError.message : 'Unable to import drug.',
            })
          }
        }
      } else {
        results.successful.push(...(data || []))
      }
    } catch (batchError) {
      for (const drug of batch) {
        try {
          const { data: singleData, error: singleError } = await adminClient
            .from('drugs')
            .insert([drug])
            .select()

          if (singleError) {
            results.failed.push({
              drug,
              error: singleError.message,
            })
          } else if (singleData?.[0]) {
            results.successful.push(singleData[0])
          }
        } catch (singleError) {
          results.failed.push({
            drug,
            error: singleError instanceof Error ? singleError.message : 'Unable to import drug.',
          })
        }
      }
    }
  }

  return results
}

const toDateOnly = (value: string) => new Date(value).toISOString().split('T')[0]

const getReportBundle = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  organizationId: string,
  payload: Record<string, unknown>,
  includeClaims: boolean
) => {
  requireRole(
    requesterProfile,
    ['admin', 'pharmacist'],
    'Only admins and pharmacists can access reports.'
  )

  const startDate = normalizeText(payload.startDate)
  const endDate = normalizeText(payload.endDate)

  let salesQuery = adminClient
    .from('sales')
    .select(SALES_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .eq('payment_status', 'completed')
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
      .select('*')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .order('created_at', { ascending: false }),
    adminClient.from('drugs').select('*').eq('organization_id', organizationId),
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
      return json({ drugs: await getDrugs(adminClient, organizationId, payload) })
    }

    if (
      action === 'get_claims' ||
      action === 'get_recent_claims' ||
      action === 'get_claims_statistics' ||
      action === 'create_claim' ||
      action === 'approve_claim' ||
      action === 'reject_claim'
    ) {
      await requireTierFeature(adminClient, organizationId, 'claims')

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

      if (action === 'create_claim') {
        return json(await createClaim(adminClient, requesterProfile, organizationId, payload))
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
      return json({
        drug: await createDrug(adminClient, requesterProfile, organizationId, payload),
      })
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
