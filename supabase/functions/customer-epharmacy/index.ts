import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  isChemicalShopMedicineAllowed,
  isChemicalShopOrganizationType,
} from '../_shared/chemicalShopInventory.ts'

const BLOCKED_CLASSES = new Set(['restricted', 'controlled', 'narcotic'])
const PAYMENT_METHODS = new Set(['momo', 'paystack', 'card', 'cash_on_delivery', 'account_transfer'])
const PRESCRIPTION_BUCKET = 'epharmacy-prescriptions'

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const number = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const today = () => new Date().toISOString().slice(0, 10)
const orderNumber = () =>
  `EPC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`

const getEnv = () => {
  const url = Deno.env.get('SUPABASE_URL') || ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error('Customer e-pharmacy environment is incomplete.')
  }
  return { url, anonKey, serviceRoleKey }
}

const getUser = async (request: Request, url: string, anonKey: string) => {
  const authorization = request.headers.get('Authorization') || ''
  const token = authorization.replace(/^Bearer\s+/i, '')
  if (!token || token === anonKey) return null

  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  })
  const { data, error } = await client.auth.getUser(token)
  if (error) return null
  return data.user || null
}

const requireUser = (user: { id: string; email?: string } | null) => {
  if (!user?.id) throw new Error('Sign in to continue with your customer order.')
  return user
}

const mapListing = (row: Record<string, unknown>, facilityMap: Map<string, Record<string, unknown>>) => {
  const quantity = number(row.quantity)
  const reorderLevel = Math.max(0, number(row.reorder_level))
  const saleClass = text(row.epharmacy_sale_class || row.medicine_access_level).toLowerCase() || 'otc'
  return {
    ...row,
    cost_price: undefined,
    supplier: undefined,
    available_quantity: Math.max(0, quantity - reorderLevel),
    sale_class: saleClass,
    prescription_required: Boolean(row.epharmacy_requires_prescription) || saleClass === 'prescription',
    facility: facilityMap.get(text(row.organization_id)) || null,
    branch: row.branches || null,
  }
}

const loadMarketplace = async (
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>
) => {
  const searchTerm = text(payload.searchTerm).replace(/[%_,]/g, '')
  const facilityId = text(payload.facilityId)
  const limit = Math.min(250, Math.max(1, number(payload.limit) || 120))

  const { data: facilities, error: facilitiesError } = await admin
    .from('organizations')
    .select('id, name, organization_type, address, city, region, phone, license_number, epharmacy_pickup_enabled, epharmacy_delivery_enabled, epharmacy_minimum_order_amount')
    .eq('epharmacy_enabled', true)
    .eq('epharmacy_license_status', 'registered')
    .in('status', ['active', 'trial'])
    .order('name')
  if (facilitiesError) throw facilitiesError

  const facilityRows = (facilities || []) as Record<string, unknown>[]
  const permittedIds = facilityRows
    .map((facility) => text(facility.id))
    .filter((id) => !facilityId || id === facilityId)

  if (!permittedIds.length) {
    return { facilities: facilityRows, listings: [] }
  }

  let query = admin
    .from('drugs')
    .select(`
      id, organization_id, branch_id, name, brand_name, generic_name, batch_number,
      expiry_date, quantity, unit, price, category, description, reorder_level, status,
      medicine_access_level, chemical_shop_sale_permitted, epharmacy_customer_visible, epharmacy_requires_prescription,
      epharmacy_sale_class, epharmacy_pickup_enabled, epharmacy_delivery_enabled,
      epharmacy_warning, branches(id, name, code)
    `)
    .in('organization_id', permittedIds)
    .eq('status', 'active')
    .eq('epharmacy_customer_visible', true)
    .gt('quantity', 0)
    .gte('expiry_date', today())
    .order('name')
    .limit(limit)

  if (searchTerm) {
    query = query.or([
      `name.ilike.%${searchTerm}%`,
      `brand_name.ilike.%${searchTerm}%`,
      `generic_name.ilike.%${searchTerm}%`,
      `category.ilike.%${searchTerm}%`,
    ].join(','))
  }

  const { data, error } = await query
  if (error) throw error
  const facilityMap = new Map(facilityRows.map((facility) => [text(facility.id), facility]))
  const listings = ((data || []) as Record<string, unknown>[])
    .filter((row) => {
      const facility = facilityMap.get(text(row.organization_id))
      return !isChemicalShopOrganizationType(facility?.organization_type) || isChemicalShopMedicineAllowed(row)
    })
    .map((row) => mapListing(row, facilityMap))
    .filter((row) => row.available_quantity > 0 && !BLOCKED_CLASSES.has(row.sale_class))

  return { facilities: facilityRows, listings }
}

const loadOrders = async (
  admin: ReturnType<typeof createClient>,
  userId: string
) => {
  const { data, error } = await admin
    .from('epharmacy_orders')
    .select('*, epharmacy_order_items(*)')
    .eq('channel', 'customer')
    .eq('customer_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(80)
  if (error) throw error

  const rows = (data || []) as Record<string, unknown>[]
  const sellerIds = [...new Set(rows.map((row) => text(row.seller_organization_id)).filter(Boolean))]
  const { data: facilities, error: facilityError } = sellerIds.length
    ? await admin.from('organizations').select('id, name, city, region, phone').in('id', sellerIds)
    : { data: [], error: null }
  if (facilityError) throw facilityError
  const facilityMap = new Map((facilities || []).map((facility) => [text(facility.id), facility]))

  return rows.map((row) => ({
    ...row,
    seller_facility: facilityMap.get(text(row.seller_organization_id)) || null,
  }))
}

const saveProfile = async (
  admin: ReturnType<typeof createClient>,
  user: { id: string; email?: string },
  profile: Record<string, unknown>
) => {
  const fullName = text(profile.fullName)
  const phone = text(profile.phone)
  if (!fullName || !phone) {
    throw new Error('Full legal name and mobile number are required.')
  }
  if (!profile.termsAccepted || !profile.privacyConsent) {
    throw new Error('Accept the customer terms and privacy consent before continuing.')
  }

  const now = new Date().toISOString()
  const row = {
    user_id: user.id,
    email: text(user.email).toLowerCase() || null,
    full_name: fullName,
    phone,
    date_of_birth: text(profile.dateOfBirth) || null,
    gender: text(profile.gender) || null,
    identity_type: text(profile.identityType) || null,
    identity_number: text(profile.identityNumber) || null,
    address: text(profile.address) || null,
    city: text(profile.city) || null,
    region: text(profile.region) || null,
    digital_address: text(profile.digitalAddress) || null,
    emergency_contact_name: text(profile.emergencyContactName) || null,
    emergency_contact_phone: text(profile.emergencyContactPhone) || null,
    allergies: text(profile.allergies) || null,
    current_medications: text(profile.currentMedications) || null,
    terms_accepted_at: now,
    privacy_consent_at: now,
    updated_at: now,
  }
  const { data, error } = await admin
    .from('epharmacy_customer_profiles')
    .upsert(row, { onConflict: 'user_id' })
    .select('*')
    .single()
  if (error) throw error
  return data
}

const createOrder = async (
  admin: ReturnType<typeof createClient>,
  user: { id: string; email?: string },
  payload: Record<string, unknown>
) => {
  const input = (payload.order || {}) as Record<string, unknown>
  const { data: profile, error: profileError } = await admin
    .from('epharmacy_customer_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()
  if (profileError) throw profileError
  if (!profile?.full_name || !profile?.phone || !profile?.terms_accepted_at || !profile?.privacy_consent_at) {
    throw new Error('Complete your customer name, phone, terms, and privacy consent before ordering.')
  }

  const sellerOrganizationId = text(input.sellerOrganizationId)
  const { data: seller, error: sellerError } = await admin
    .from('organizations')
    .select('id, name, organization_type, epharmacy_enabled, epharmacy_license_status, epharmacy_pickup_enabled, epharmacy_delivery_enabled, epharmacy_minimum_order_amount')
    .eq('id', sellerOrganizationId)
    .eq('epharmacy_enabled', true)
    .eq('epharmacy_license_status', 'registered')
    .maybeSingle()
  if (sellerError) throw sellerError
  if (!seller) throw new Error('The selected facility is not available for customer orders.')

  const fulfillmentMethod = text(input.fulfillmentMethod) === 'delivery' ? 'delivery' : 'pickup'
  if (fulfillmentMethod === 'pickup' && seller.epharmacy_pickup_enabled === false) {
    throw new Error('This facility is not accepting pickup orders.')
  }
  if (fulfillmentMethod === 'delivery' && !seller.epharmacy_delivery_enabled) {
    throw new Error('This facility is not accepting delivery orders.')
  }

  const items = Array.isArray(input.items) ? input.items as Record<string, unknown>[] : []
  if (!items.length) throw new Error('Add at least one medicine to the order.')
  const drugIds = [...new Set(items.map((item) => text(item.drugId)).filter(Boolean))]
  const { data: drugs, error: drugsError } = await admin
    .from('drugs')
    .select('id, organization_id, branch_id, name, brand_name, generic_name, batch_number, expiry_date, quantity, unit, price, reorder_level, status, medicine_access_level, chemical_shop_sale_permitted, epharmacy_customer_visible, epharmacy_requires_prescription, epharmacy_sale_class')
    .eq('organization_id', sellerOrganizationId)
    .eq('status', 'active')
    .in('id', drugIds)
  if (drugsError) throw drugsError

  const drugMap = new Map((drugs || []).map((drug) => [text(drug.id), drug]))
  let prescriptionRequired = false
  const orderItems = items.map((item) => {
    const drug = drugMap.get(text(item.drugId))
    if (!drug) throw new Error('A selected medicine is no longer available.')
    if (isChemicalShopOrganizationType(seller.organization_type) && !isChemicalShopMedicineAllowed(drug)) {
      throw new Error(`${drug.name} is not permitted for Chemical Shop ordering.`)
    }
    const saleClass = text(drug.epharmacy_sale_class).toLowerCase() || 'otc'
    if (BLOCKED_CLASSES.has(saleClass)) throw new Error(`${drug.name} cannot be ordered online.`)
    if (!drug.epharmacy_customer_visible) throw new Error(`${drug.name} is not published for customer ordering.`)
    if (!drug.expiry_date || String(drug.expiry_date) < today()) throw new Error(`${drug.name} is expired or unavailable.`)
    const quantity = number(item.quantity)
    const available = Math.max(0, number(drug.quantity) - Math.max(0, number(drug.reorder_level)))
    if (quantity <= 0 || quantity > available) throw new Error(`${drug.name} has only ${available} unit(s) available.`)
    const needsPrescription = Boolean(drug.epharmacy_requires_prescription) || saleClass === 'prescription'
    prescriptionRequired ||= needsPrescription
    return {
      drug,
      quantity,
      row: {
        drug_id: drug.id,
        seller_organization_id: sellerOrganizationId,
        buyer_organization_id: null,
        drug_name: drug.name,
        brand_name: drug.brand_name,
        generic_name: drug.generic_name,
        batch_number: drug.batch_number,
        expiry_date: drug.expiry_date,
        quantity,
        unit: drug.unit || 'unit',
        unit_price: number(drug.price),
        total_amount: quantity * number(drug.price),
        sale_class: saleClass,
        prescription_required: needsPrescription,
      },
    }
  })

  if (fulfillmentMethod === 'delivery' && (!text(input.deliveryAddress) || !text(input.deliveryCity) || !text(input.deliveryRegion))) {
    throw new Error('Delivery address, city, and region are required.')
  }

  const patientName = text(input.patientName) || profile.full_name
  const patientDateOfBirth = text(input.patientDateOfBirth) || text(profile.date_of_birth)
  const prescription = (input.prescription || {}) as Record<string, unknown>
  if (prescriptionRequired) {
    if (!profile.date_of_birth || !profile.gender || !profile.identity_number) {
      throw new Error('Date of birth, gender, and identity number are required for prescription orders.')
    }
    if (!text(profile.allergies) || !text(profile.current_medications)) {
      throw new Error('Allergies and current medicines are required for prescription review.')
    }
    if (!patientName || !patientDateOfBirth) {
      throw new Error('Patient name and date of birth are required for prescription orders.')
    }
    const prescriptionPath = text(prescription.path)
    if (!prescriptionPath.startsWith(`${user.id}/`)) {
      throw new Error('Upload a valid prescription owned by your customer account.')
    }
  }

  const totalAmount = orderItems.reduce((sum, item) => sum + item.row.total_amount, 0)
  const minimumOrder = number(seller.epharmacy_minimum_order_amount)
  if (minimumOrder > 0 && totalAmount < minimumOrder) {
    throw new Error(`Minimum order amount for this facility is GHS ${minimumOrder.toFixed(2)}.`)
  }

  const { data: order, error: orderError } = await admin
    .from('epharmacy_orders')
    .insert({
      order_number: orderNumber(),
      channel: 'customer',
      customer_user_id: user.id,
      customer_name: profile.full_name,
      customer_phone: profile.phone,
      customer_email: profile.email || user.email || null,
      seller_organization_id: sellerOrganizationId,
      seller_branch_id: text(input.sellerBranchId) || text(orderItems[0]?.drug.branch_id) || null,
      ordering_for: text(input.orderingFor) || 'self',
      patient_name: patientName || null,
      patient_date_of_birth: patientDateOfBirth || null,
      patient_relationship: text(input.patientRelationship) || null,
      prescription_required: prescriptionRequired,
      prescription_file_path: text(prescription.path) || null,
      prescription_file_name: text(prescription.name) || null,
      prescription_file_type: text(prescription.type) || null,
      prescription_file_size: number(prescription.size) || null,
      status: 'pending_review',
      fulfillment_method: fulfillmentMethod,
      payment_method: PAYMENT_METHODS.has(text(input.paymentMethod)) ? text(input.paymentMethod) : 'momo',
      payment_status: 'pending',
      total_amount: totalAmount,
      delivery_address: fulfillmentMethod === 'delivery' ? text(input.deliveryAddress) : null,
      delivery_city: fulfillmentMethod === 'delivery' ? text(input.deliveryCity) : null,
      delivery_region: fulfillmentMethod === 'delivery' ? text(input.deliveryRegion) : null,
      delivery_digital_address: fulfillmentMethod === 'delivery' ? text(input.deliveryDigitalAddress) : null,
      notes: text(input.notes) || null,
      clinical_notes: text(input.clinicalNotes) || null,
      requested_by: null,
    })
    .select('*')
    .single()
  if (orderError) throw orderError

  const { error: itemError } = await admin
    .from('epharmacy_order_items')
    .insert(orderItems.map((item) => ({ order_id: order.id, ...item.row })))
  if (itemError) {
    await admin.from('epharmacy_orders').delete().eq('id', order.id)
    throw itemError
  }

  return order
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const payload = await request.json() as Record<string, unknown>
    const action = text(payload.action)
    const { url, anonKey, serviceRoleKey } = getEnv()
    const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } })
    const user = await getUser(request, url, anonKey)

    if (action === 'get_marketplace') {
      return json(await loadMarketplace(admin, payload))
    }

    const customer = requireUser(user)

    if (action === 'get_account') {
      const { data: profile, error } = await admin
        .from('epharmacy_customer_profiles')
        .select('*')
        .eq('user_id', customer.id)
        .maybeSingle()
      if (error) throw error
      return json({ profile, orders: await loadOrders(admin, customer.id) })
    }

    if (action === 'save_profile') {
      const profile = await saveProfile(
        admin,
        customer,
        (payload.profile || {}) as Record<string, unknown>
      )
      return json({ profile })
    }

    if (action === 'create_order') {
      await createOrder(admin, customer, payload)
      return json({ orders: await loadOrders(admin, customer.id) })
    }

    return json({ error: `Unsupported customer e-pharmacy action: ${action}` }, 400)
  } catch (error) {
    console.error('customer-epharmacy error:', error)
    return json({ error: error instanceof Error ? error.message : 'Customer e-pharmacy request failed.' }, 400)
  }
})
