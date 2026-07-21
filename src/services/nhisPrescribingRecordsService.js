import { supabase } from '../lib/supabase'
import { assertRequiredText, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import {
  createBranchRecord,
  listBranchRecords,
  shouldUseBranchServer,
  updateBranchRecord,
} from './branchServerApi'
import { getConnectivityState } from './connectivityService'
import { tryLogAuditEvent } from './auditService'

export const NHIS_PRESCRIBER_TYPES = [
  'Doctor',
  'Physician assistant',
  'Nurse prescriber',
  'Midwife',
  'Dentist',
  'Other authorized prescriber',
]

export const NHIS_PRESCRIBING_FACILITY_TYPES = [
  'Hospital',
  'Clinic',
  'Health Centre',
  'CHPS Compound',
  'Maternity Home',
  'Dental Clinic',
  'Community Pharmacy',
  'Other',
]

export const NHIS_PRESCRIBING_OWNERSHIP_TYPES = [
  'Public',
  'Private',
  'Mission/Faith-based',
  'Quasi-government',
  'Other',
]

const ACTIVE_STATUSES = new Set(['active', 'inactive', 'unverified'])
const VERIFY_STATUSES = new Set(['verified', 'unverified', 'rejected'])

const normalizeStatus = (value, fallback = 'active') => {
  const normalized = normalizeText(value).toLowerCase()
  return ACTIVE_STATUSES.has(normalized) ? normalized : fallback
}

const normalizeVerificationStatus = (value, fallback = 'unverified') => {
  const normalized = normalizeText(value).toLowerCase()
  return VERIFY_STATUSES.has(normalized) ? normalized : fallback
}

const toNullableUuid = (value) => {
  const normalized = normalizeText(value)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null
}

const nowIso = () => new Date().toISOString()

const buildSearchFilter = (fields, term) => {
  const safeTerm = sanitizeSearchTerm(term)
  return safeTerm ? fields.map((field) => `${field}.ilike.%${safeTerm}%`).join(',') : ''
}

const throwFriendlyDuplicateError = (error, message) => {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(' ').toLowerCase()

  if (error?.code === '23505' || text.includes('duplicate') || text.includes('unique')) {
    throw new Error(message)
  }

  throw error
}

const withOrganization = (payload = {}, options = {}) => {
  const organizationId = toNullableUuid(
    payload.organizationId || payload.organization_id || options.organizationId || options.organization_id
  )
  const branchId = toNullableUuid(payload.branchId || payload.branch_id || options.branchId || options.branch_id)
  return {
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(branchId ? { branch_id: branchId } : {}),
  }
}

export const normalizeNhisPrescribingFacilityPayload = (facility = {}, options = {}) => ({
  ...withOrganization(facility, options),
  facility_name: assertRequiredText(
    facility.facilityName ?? facility.facility_name,
    'Prescribing facility name'
  ),
  facility_type: normalizeText(facility.facilityType ?? facility.facility_type) || null,
  nhia_facility_code: normalizeText(facility.nhiaFacilityCode ?? facility.nhia_facility_code) || null,
  provider_number: normalizeText(facility.providerNumber ?? facility.provider_number) || null,
  ownership_type: normalizeText(facility.ownershipType ?? facility.ownership_type) || null,
  address: normalizeText(facility.address) || null,
  region: normalizeText(facility.region) || null,
  district: normalizeText(facility.district) || null,
  town: normalizeText(facility.town) || null,
  phone: normalizeText(facility.phone) || null,
  email: normalizeText(facility.email) || null,
  contact_person: normalizeText(facility.contactPerson ?? facility.contact_person) || null,
  status: normalizeStatus(facility.status),
  verification_status: normalizeVerificationStatus(facility.verificationStatus ?? facility.verification_status),
  notes: normalizeText(facility.notes) || null,
  updated_by: toNullableUuid(facility.updatedBy ?? facility.updated_by ?? options.userId),
})

export const normalizeNhisPrescriberPayload = (prescriber = {}, options = {}) => ({
  ...withOrganization(prescriber, options),
  full_name: assertRequiredText(prescriber.fullName ?? prescriber.full_name, 'Prescriber name'),
  title: normalizeText(prescriber.title) || null,
  professional_type: normalizeText(prescriber.professionalType ?? prescriber.professional_type) || 'Doctor',
  license_number: normalizeText(prescriber.licenseNumber ?? prescriber.license_number) || null,
  phone: normalizeText(prescriber.phone) || null,
  email: normalizeText(prescriber.email) || null,
  primary_facility_id: toNullableUuid(prescriber.primaryFacilityId ?? prescriber.primary_facility_id),
  specialty: normalizeText(prescriber.specialty) || null,
  status: normalizeStatus(prescriber.status),
  verification_status: normalizeVerificationStatus(prescriber.verificationStatus ?? prescriber.verification_status),
  notes: normalizeText(prescriber.notes) || null,
  updated_by: toNullableUuid(prescriber.updatedBy ?? prescriber.updated_by ?? options.userId),
})

export const getNhisPrescribingFacilityDisplayName = (facility = {}) =>
  normalizeText(facility.facility_name ?? facility.facilityName)

export const getNhisPrescriberDisplayName = (prescriber = {}) => {
  const name = normalizeText(prescriber.full_name ?? prescriber.fullName)
  const license = normalizeText(prescriber.license_number ?? prescriber.licenseNumber)
  return license ? `${name} (${license})` : name
}

const listFromBranch = async (entityType, filters = {}) => {
  const resource = entityType === 'facilities'
    ? 'nhis/prescribing-facilities'
    : 'nhis/prescribers'
  return await listBranchRecords(resource, {
    searchTerm: filters.searchTerm || filters.search || '',
    status: filters.status || '',
    limit: filters.limit || 1000,
  })
}

export const listNhisPrescribingFacilities = async (filters = {}) => {
  if (shouldUseBranchServer()) {
    const localRows = await listFromBranch('facilities', filters)
    if (localRows.length || getConnectivityState().internetAvailable === false) return localRows
  }

  let query = supabase
    .from('nhis_prescribing_facilities')
    .select('*')
    .order('facility_name', { ascending: true })
    .limit(Number(filters.limit || 1000))

  const status = normalizeText(filters.status)
  if (status && status !== 'all') query = query.eq('status', status)

  const searchFilter = buildSearchFilter(
    ['facility_name', 'nhia_facility_code', 'provider_number', 'region', 'district', 'town'],
    filters.searchTerm || filters.search
  )
  if (searchFilter) query = query.or(searchFilter)

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export const listNhisPrescribers = async (filters = {}) => {
  if (shouldUseBranchServer()) {
    const localRows = await listFromBranch('prescribers', filters)
    if (localRows.length || getConnectivityState().internetAvailable === false) return localRows
  }

  let query = supabase
    .from('nhis_prescribers')
    .select('*')
    .order('full_name', { ascending: true })
    .limit(Number(filters.limit || 1000))

  const status = normalizeText(filters.status)
  if (status && status !== 'all') query = query.eq('status', status)

  const facilityId = toNullableUuid(filters.facilityId || filters.facility_id)
  if (facilityId) query = query.eq('primary_facility_id', facilityId)

  const searchFilter = buildSearchFilter(
    ['full_name', 'license_number', 'professional_type', 'specialty', 'phone'],
    filters.searchTerm || filters.search
  )
  if (searchFilter) query = query.or(searchFilter)

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export const createNhisPrescribingFacility = async (facility, options = {}) => {
  const payload = {
    ...normalizeNhisPrescribingFacilityPayload(facility, options),
    created_by: toNullableUuid(facility.createdBy ?? facility.created_by ?? options.userId),
  }

  if (shouldUseBranchServer()) {
    return await createBranchRecord('nhis/prescribing-facilities', payload)
  }

  const { data, error } = await supabase
    .from('nhis_prescribing_facilities')
    .insert([payload])
    .select()
    .single()

  if (error) throwFriendlyDuplicateError(error, 'This prescribing facility already exists.')
  await tryLogAuditEvent({
    eventType: 'nhis_prescribing_facility.created',
    entityType: 'nhis_prescribing_facility',
    entityId: data?.id,
    action: 'create',
    details: { facility_name: data?.facility_name, organization_id: data?.organization_id },
  })
  return data
}

export const updateNhisPrescribingFacility = async (id, facility, options = {}) => {
  const payload = {
    ...normalizeNhisPrescribingFacilityPayload(facility, options),
    updated_at: nowIso(),
  }

  if (shouldUseBranchServer()) {
    return await updateBranchRecord('nhis/prescribing-facilities', id, payload)
  }

  const { data, error } = await supabase
    .from('nhis_prescribing_facilities')
    .update(payload)
    .eq('id', id)
    .select()
    .single()

  if (error) throwFriendlyDuplicateError(error, 'This prescribing facility already exists.')
  await tryLogAuditEvent({
    eventType: 'nhis_prescribing_facility.updated',
    entityType: 'nhis_prescribing_facility',
    entityId: data?.id,
    action: 'update',
    details: { facility_name: data?.facility_name, organization_id: data?.organization_id },
  })
  return data
}

export const deactivateNhisPrescribingFacility = async (id, options = {}) =>
  await updateNhisPrescribingFacility(id, { ...(options.record || {}), status: 'inactive' }, options)

export const createNhisPrescriber = async (prescriber, options = {}) => {
  const payload = {
    ...normalizeNhisPrescriberPayload(prescriber, options),
    created_by: toNullableUuid(prescriber.createdBy ?? prescriber.created_by ?? options.userId),
  }

  if (shouldUseBranchServer()) {
    return await createBranchRecord('nhis/prescribers', payload)
  }

  const { data, error } = await supabase
    .from('nhis_prescribers')
    .insert([payload])
    .select()
    .single()

  if (error) throwFriendlyDuplicateError(error, 'This prescriber already exists.')
  await tryLogAuditEvent({
    eventType: 'nhis_prescriber.created',
    entityType: 'nhis_prescriber',
    entityId: data?.id,
    action: 'create',
    details: { full_name: data?.full_name, license_number: data?.license_number, organization_id: data?.organization_id },
  })
  return data
}

export const updateNhisPrescriber = async (id, prescriber, options = {}) => {
  const payload = {
    ...normalizeNhisPrescriberPayload(prescriber, options),
    updated_at: nowIso(),
  }

  if (shouldUseBranchServer()) {
    return await updateBranchRecord('nhis/prescribers', id, payload)
  }

  const { data, error } = await supabase
    .from('nhis_prescribers')
    .update(payload)
    .eq('id', id)
    .select()
    .single()

  if (error) throwFriendlyDuplicateError(error, 'This prescriber already exists.')
  await tryLogAuditEvent({
    eventType: 'nhis_prescriber.updated',
    entityType: 'nhis_prescriber',
    entityId: data?.id,
    action: 'update',
    details: { full_name: data?.full_name, license_number: data?.license_number, organization_id: data?.organization_id },
  })
  return data
}

export const deactivateNhisPrescriber = async (id, options = {}) =>
  await updateNhisPrescriber(id, { ...(options.record || {}), status: 'inactive' }, options)

export const buildNhisPrescriptionSourceSnapshot = ({ facility = null, prescriber = null } = {}) => ({
  prescribingFacilityId: facility?.id || '',
  prescribing_facility_id: facility?.id || null,
  prescriberId: prescriber?.id || '',
  prescriber_id: prescriber?.id || null,
  referringFacility: getNhisPrescribingFacilityDisplayName(facility),
  physicianName: getNhisPrescriberDisplayName(prescriber),
  prescribingFacilityNameSnapshot: getNhisPrescribingFacilityDisplayName(facility),
  prescribing_facility_name_snapshot: getNhisPrescribingFacilityDisplayName(facility) || null,
  prescribingFacilityCodeSnapshot: normalizeText(facility?.nhia_facility_code ?? facility?.nhiaFacilityCode) || '',
  prescribing_facility_code_snapshot: normalizeText(facility?.nhia_facility_code ?? facility?.nhiaFacilityCode) || null,
  prescriberNameSnapshot: normalizeText(prescriber?.full_name ?? prescriber?.fullName) || '',
  prescriber_name_snapshot: normalizeText(prescriber?.full_name ?? prescriber?.fullName) || null,
  prescriberLicenseSnapshot: normalizeText(prescriber?.license_number ?? prescriber?.licenseNumber) || '',
  prescriber_license_snapshot: normalizeText(prescriber?.license_number ?? prescriber?.licenseNumber) || null,
})
