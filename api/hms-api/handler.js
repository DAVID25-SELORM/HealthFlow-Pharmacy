import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export const config = {
  api: {
    bodyParser: false,
  },
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const configuredMaxBodyBytes = Number(process.env.HMS_API_MAX_BODY_BYTES || 1024 * 1024)

const hmsConfig = {
  supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
  token: process.env.HMS_API_TOKEN || '',
  tokenHeader: String(process.env.HMS_API_TOKEN_HEADER || 'x-hms-api-token').trim().toLowerCase(),
  allowedOrigins: String(process.env.HMS_API_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  maxBodyBytes: Math.max(1024, Number.isFinite(configuredMaxBodyBytes) ? configuredMaxBodyBytes : 1024 * 1024),
}

let supabaseClient = null

const getSupabase = () => {
  if (!hmsConfig.supabaseUrl || !hmsConfig.supabaseServiceKey) {
    throw Object.assign(new Error('Supabase server credentials are not configured.'), { status: 503 })
  }

  if (!supabaseClient) {
    supabaseClient = createClient(hmsConfig.supabaseUrl, hmsConfig.supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  }

  return supabaseClient
}

const json = (response, status, body) => {
  response.status(status)
  response.setHeader('cache-control', 'no-store')
  response.json(body)
}

const normalizeText = (value) => String(value ?? '').trim()

const normalizeNullableText = (value) => {
  const text = normalizeText(value)
  return text || null
}

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const clampLimit = (value, fallback = 50, max = 100) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

const safeTokenEquals = (actual, expected) => {
  if (!actual || !expected) return false
  const actualBuffer = Buffer.from(String(actual), 'utf8')
  const expectedBuffer = Buffer.from(String(expected), 'utf8')
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

const getPathSegments = (request) => {
  const path = request.query?.path
  if (Array.isArray(path)) return path
  if (typeof path === 'string' && path) return path.split('/').filter(Boolean)
  return []
}

const getSameHostOrigins = (request) => {
  const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '').trim()
  if (!host) return []
  const protocol = String(request.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https'
  return [`${protocol}://${host}`.replace(/\/+$/, '')]
}

const isAllowedOrigin = (request) => {
  const origin = request.headers?.origin || ''
  if (!origin) return true

  const normalizedOrigin = origin.replace(/\/+$/, '')
  if (getSameHostOrigins(request).includes(normalizedOrigin)) return true
  return hmsConfig.allowedOrigins.includes(normalizedOrigin)
}

const setCorsHeaders = (request, response) => {
  const origin = request.headers?.origin || ''
  if (origin && isAllowedOrigin(request)) {
    response.setHeader('access-control-allow-origin', origin.replace(/\/+$/, ''))
  }
  response.setHeader('vary', 'Origin')
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  response.setHeader('access-control-allow-headers', `content-type, authorization, ${hmsConfig.tokenHeader}`)
}

const requireToken = (request) => {
  if (!hmsConfig.token) {
    throw Object.assign(new Error('HMS API token is not configured.'), { status: 503 })
  }

  const bearer = String(request.headers?.authorization || '').replace(/^bearer\s+/i, '')
  const headerToken = request.headers?.[hmsConfig.tokenHeader] || bearer
  if (!safeTokenEquals(headerToken, hmsConfig.token)) {
    throw Object.assign(new Error('HMS API token is invalid or missing.'), { status: 401 })
  }
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0

    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > hmsConfig.maxBodyBytes) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

const readJsonBody = async (request) => {
  const rawBody = await readBody(request)
  if (!rawBody) return {}

  try {
    return JSON.parse(rawBody)
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })
  }
}

const assertRequiredText = (value, label) => {
  const text = normalizeText(value)
  if (!text) {
    throw Object.assign(new Error(`${label} is required.`), { status: 400 })
  }
  return text
}

const assertItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('At least one prescription item is required.'), { status: 400 })
  }

  return items.map((item, index) => {
    const quantity = toNumber(item.quantity, Number.NaN)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw Object.assign(new Error(`Item ${index + 1} quantity must be greater than zero.`), { status: 400 })
    }

    const unitPrice = toNumber(item.unit_price ?? item.unitPrice ?? item.price, 0)
    if (unitPrice < 0) {
      throw Object.assign(new Error(`Item ${index + 1} price cannot be negative.`), { status: 400 })
    }

    const totalPrice = toNumber(item.total_price ?? item.totalPrice, quantity * unitPrice)
    if (totalPrice < 0) {
      throw Object.assign(new Error(`Item ${index + 1} total price cannot be negative.`), { status: 400 })
    }

    return {
      drug_id: normalizeNullableText(item.drug_id ?? item.drugId),
      drug_name: assertRequiredText(item.drug_name ?? item.drugName ?? item.name, `Item ${index + 1} drug name`),
      quantity,
      unit_price: unitPrice,
      total_price: totalPrice,
      directions: normalizeNullableText(item.directions),
    }
  })
}

const buildHmsNote = (body) => {
  const details = {
    source: 'hms-api',
    externalPrescriptionId: normalizeNullableText(body.external_prescription_id ?? body.externalPrescriptionId),
    encounterId: normalizeNullableText(body.encounter_id ?? body.encounterId),
    prescriberName: normalizeNullableText(body.prescriber_name ?? body.prescriberName),
    prescriberId: normalizeNullableText(body.prescriber_id ?? body.prescriberId),
    clinicalNotes: normalizeNullableText(body.notes),
  }

  return JSON.stringify(details)
}

const mapMedicine = (row) => ({
  id: row.id,
  name: row.name,
  brandName: row.brand_name || null,
  genericName: row.generic_name || null,
  batchNumber: row.batch_number || null,
  expiryDate: row.expiry_date || null,
  quantity: toNumber(row.quantity, 0),
  unit: row.unit || null,
  cashPrice: toNumber(row.price, 0),
  nhisCode: row.nhis_code || null,
  nhisPrice: row.nhis_price === null || row.nhis_price === undefined ? null : toNumber(row.nhis_price, 0),
  nhisUnit: row.nhis_unit || null,
  isNhisListed: Boolean(row.is_nhis_listed),
  category: row.category || null,
  status: row.status || 'active',
  branchId: row.branch_id || null,
  updatedAt: row.updated_at || null,
})

const findExistingPatient = async (supabase, patient) => {
  const patientId = normalizeText(patient.id ?? patient.patient_id ?? patient.patientId)
  if (UUID_PATTERN.test(patientId)) {
    const { data, error } = await supabase.from('patients').select('*').eq('id', patientId).maybeSingle()
    if (error && error.code !== 'PGRST116') throw error
    if (data) return data
  }

  const insuranceId = normalizeText(patient.insurance_id ?? patient.insuranceId)
  if (insuranceId) {
    const { data, error } = await supabase.from('patients').select('*').eq('insurance_id', insuranceId).limit(1)
    if (error) throw error
    if (data?.[0]) return data[0]
  }

  const phone = normalizeText(patient.phone)
  const fullName = normalizeText(patient.full_name ?? patient.fullName ?? patient.name)
  if (phone && fullName) {
    const { data, error } = await supabase
      .from('patients')
      .select('*')
      .eq('phone', phone)
      .ilike('full_name', fullName)
      .limit(1)

    if (error) throw error
    if (data?.[0]) return data[0]
  }

  return null
}

const upsertPatient = async (supabase, patientPayload) => {
  const patient = patientPayload || {}
  const fullName = assertRequiredText(patient.full_name ?? patient.fullName ?? patient.name, 'Patient full name')
  const phone = assertRequiredText(patient.phone, 'Patient phone')
  const existing = await findExistingPatient(supabase, patient)
  const row = {
    full_name: fullName,
    phone,
    email: normalizeNullableText(patient.email),
    date_of_birth: normalizeNullableText(patient.date_of_birth ?? patient.dateOfBirth),
    gender: normalizeNullableText(patient.gender),
    address: normalizeNullableText(patient.address),
    insurance_provider: normalizeNullableText(patient.insurance_provider ?? patient.insuranceProvider),
    insurance_id: normalizeNullableText(patient.insurance_id ?? patient.insuranceId),
    allergies: normalizeNullableText(patient.allergies),
    medical_notes: normalizeNullableText(patient.medical_notes ?? patient.medicalNotes),
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    const { data, error } = await supabase
      .from('patients')
      .update(row)
      .eq('id', existing.id)
      .select('*')
      .single()

    if (error) throw error
    return { patient: data, action: 'updated' }
  }

  const { updated_at: _updatedAt, ...insertRow } = row
  const { data, error } = await supabase
    .from('patients')
    .insert([insertRow])
    .select('*')
    .single()

  if (error) throw error
  return { patient: data, action: 'created' }
}

const listMedicines = async (request) => {
  const supabase = getSupabase()
  const url = new URL(request.url || '/', 'https://healthflow.local')
  const search = normalizeText(url.searchParams.get('search'))
  const branchId = normalizeText(url.searchParams.get('branch_id'))
  const inStockOnly = ['1', 'true', 'yes'].includes(normalizeText(url.searchParams.get('in_stock')).toLowerCase())
  const limit = clampLimit(url.searchParams.get('limit'))

  let query = supabase
    .from('drugs')
    .select('*')
    .eq('status', 'active')
    .order('name')
    .limit(limit)

  if (search) {
    const safeSearch = search.replace(/[^\w\s.-]/g, '').replace(/[%_,]/g, '')
    query = query.or([
      `name.ilike.%${safeSearch}%`,
      `brand_name.ilike.%${safeSearch}%`,
      `generic_name.ilike.%${safeSearch}%`,
      `batch_number.ilike.%${safeSearch}%`,
      `nhis_code.ilike.%${safeSearch}%`,
    ].join(','))
  }

  if (branchId) query = query.eq('branch_id', branchId)
  if (inStockOnly) query = query.gt('quantity', 0)

  const { data, error } = await query
  if (error) throw error

  return { medicines: (data || []).map(mapMedicine), count: data?.length || 0 }
}

const getMedicine = async (medicineId) => {
  const supabase = getSupabase()
  const { data, error } = await supabase.from('drugs').select('*').eq('id', medicineId).single()
  if (error) throw error
  return { medicine: mapMedicine(data) }
}

const handlePatientPost = async (request) => {
  const supabase = getSupabase()
  const body = await readJsonBody(request)
  return upsertPatient(supabase, body.patient || body)
}

const createPrescription = async (request) => {
  const supabase = getSupabase()
  const body = await readJsonBody(request)
  const items = assertItems(body.items)
  const { patient, action } = await upsertPatient(supabase, body.patient)
  const totalAmount = items.reduce((sum, item) => sum + item.total_price, 0)
  const claimNumber = normalizeText(body.prescription_number ?? body.prescriptionNumber) ||
    `HMS-${Date.now()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`

  const { data: claim, error: claimError } = await supabase
    .from('claims')
    .insert([{
      claim_number: claimNumber,
      patient_id: patient.id,
      patient_name: patient.full_name,
      insurance_provider: normalizeText(body.insurance_provider ?? body.insuranceProvider) ||
        patient.insurance_provider ||
        'private',
      insurance_id: normalizeText(body.insurance_id ?? body.insuranceId) ||
        patient.insurance_id ||
        'private',
      service_date: normalizeText(body.service_date ?? body.serviceDate) || new Date().toISOString().slice(0, 10),
      total_amount: totalAmount,
      claim_status: 'pending',
      prescription_url: normalizeNullableText(body.prescription_url ?? body.prescriptionUrl),
      notes: buildHmsNote(body),
    }])
    .select('*')
    .single()

  if (claimError) throw claimError

  const claimItems = items.map(({ directions: _directions, ...item }) => ({
    ...item,
    claim_id: claim.id,
  }))

  const { data: savedItems, error: itemsError } = await supabase
    .from('claim_items')
    .insert(claimItems)
    .select('*')

  if (itemsError) throw itemsError

  return {
    prescription: {
      id: claim.id,
      reference: claim.claim_number,
      status: 'pending_pharmacy_review',
      totalAmount,
      patientId: patient.id,
      patientAction: action,
      items: savedItems || [],
    },
  }
}

const getDispensingStatus = async (reference) => {
  const supabase = getSupabase()
  const isUuid = UUID_PATTERN.test(reference)

  let salesQuery = supabase
    .from('sales')
    .select('*, patients(*), sale_items(*)')
    .limit(1)

  salesQuery = isUuid ? salesQuery.eq('id', reference) : salesQuery.eq('sale_number', reference)

  const { data: sales, error: salesError } = await salesQuery
  if (salesError) throw salesError
  if (sales?.[0]) {
    const sale = sales[0]
    return {
      dispensing: {
        type: 'sale',
        id: sale.id,
        reference: sale.sale_number,
        status: sale.payment_status || 'completed',
        dispensedAt: sale.sale_date,
        patient: sale.patients || null,
        items: sale.sale_items || [],
      },
    }
  }

  let claimsQuery = supabase
    .from('claims')
    .select('*, patients(*), claim_items(*)')
    .limit(1)

  claimsQuery = isUuid ? claimsQuery.eq('id', reference) : claimsQuery.eq('claim_number', reference)

  const { data: claims, error: claimsError } = await claimsQuery
  if (claimsError) throw claimsError
  if (claims?.[0]) {
    const claim = claims[0]
    return {
      dispensing: {
        type: 'prescription',
        id: claim.id,
        reference: claim.claim_number,
        status: claim.claim_status || 'pending',
        dispensedAt: claim.processed_at || null,
        patient: claim.patients || null,
        items: claim.claim_items || [],
      },
    }
  }

  throw Object.assign(new Error('Dispensing reference was not found.'), { status: 404 })
}

const getHealth = () => ({
  ok: true,
  mode: 'healthflow-hms-api',
  path: '/hms-api',
  supabaseConfigured: Boolean(hmsConfig.supabaseUrl && hmsConfig.supabaseServiceKey),
  tokenProtected: Boolean(hmsConfig.token),
})

export default async function handler(request, response) {
  setCorsHeaders(request, response)

  try {
    if (!isAllowedOrigin(request)) {
      throw Object.assign(new Error('Origin is not allowed for this HMS API.'), { status: 403 })
    }

    if (request.method === 'OPTIONS') {
      response.status(204).end()
      return
    }

    const segments = getPathSegments(request)
    const [resource, id] = segments

    if (request.method === 'GET' && (!resource || resource === 'health')) {
      json(response, 200, getHealth())
      return
    }

    requireToken(request)

    if (request.method === 'GET' && resource === 'medicines' && !id) {
      json(response, 200, await listMedicines(request))
      return
    }

    if (request.method === 'GET' && resource === 'medicines' && id) {
      json(response, 200, await getMedicine(id))
      return
    }

    if (request.method === 'POST' && resource === 'patients') {
      json(response, 200, await handlePatientPost(request))
      return
    }

    if (request.method === 'POST' && resource === 'prescriptions') {
      json(response, 201, await createPrescription(request))
      return
    }

    if (request.method === 'GET' && resource === 'dispensing' && id) {
      json(response, 200, await getDispensingStatus(id))
      return
    }

    json(response, 404, { error: 'HMS API endpoint was not found.' })
  } catch (error) {
    const status = Number(error?.status || error?.statusCode || 500)
    json(response, status >= 400 && status < 600 ? status : 500, {
      error: error?.message || 'HMS API request failed.',
      code: error?.code || undefined,
    })
  }
}
