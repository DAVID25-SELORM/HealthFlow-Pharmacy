import { supabase } from '../lib/supabase'
import { assertRequiredText, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import { normalizeNhiaMemberNumber, validateNhiaMemberNumberFormat } from '../utils/nhiaMemberNumber'
import { tryLogAuditEvent } from './auditService'
import {
  createBranchRecord,
  listBranchRecords,
  updateBranchRecord,
} from './branchServerApi'
import { routeRead, routeWrite, shouldRouteToLocal } from './apiRouter'
import { getConnectivityState } from './connectivityService'
import { invokeTierAccess } from './tierAccessService'

const PATIENT_INSURANCE_ID_UNIQUE_CONSTRAINTS = [
  'idx_patients_org_insurance_id_unique',
  'idx_patients_org_nhis_member_no_unique',
  'idx_patients_org_nhis_hin_unique',
]

const PATIENT_INSURANCE_ID_FIELDS = ['insurance_id', 'nhis_member_no', 'nhis_hin']

const NHIS_CLAIM_PATIENT_LOOKUP_LIMIT = 1000

const NHIS_CLAIM_PATIENT_SELECT = [
  'id',
  'claim_number',
  'patient_id',
  'member_no',
  'hin',
  'surname',
  'other_names',
  'phone',
  'patient_phone',
  'email',
  'gender',
  'date_of_birth',
  'patient_address',
  'insurance_provider',
  'insurance_id',
  'folder_no',
  'service_date',
  'service_date_from',
  'dispensing_date',
  'created_at',
].join(', ')

const normalizeInsuranceId = (provider, value) => {
  const insuranceId = normalizeText(value)
  if (normalizeText(provider).toLowerCase() !== 'nhis' || !insuranceId) {
    return insuranceId
  }

  const issue = validateNhiaMemberNumberFormat(insuranceId)
  if (issue) {
    throw new Error(issue)
  }

  return normalizeNhiaMemberNumber(insuranceId)
}

const getErrorText = (error) =>
  [
    error?.message,
    error?.details,
    error?.hint,
    error?.constraint,
    error?.code,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

const throwFriendlyPatientError = (error) => {
  const errorText = getErrorText(error)
  const isDuplicateInsuranceIdentifier =
    error?.code === '23505' &&
    (
      PATIENT_INSURANCE_ID_UNIQUE_CONSTRAINTS.some((constraint) =>
        errorText.includes(constraint)
      ) ||
      PATIENT_INSURANCE_ID_FIELDS.some((field) => errorText.includes(field))
    )

  if (isDuplicateInsuranceIdentifier) {
    throw new Error('This member ID already exists for another patient.')
  }

  throw error
}

/**
 * Patient Service
 * Handles all patient-related operations
 */

const fetchPatientsFromSupabase = async () => {
  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error
  const nhisClaimPatients = await fetchNhisClaimPatientsFromSupabase().catch(() => [])
  return mergePatients(data || [], nhisClaimPatients)
}

// Get all patients
export const getAllPatients = async () => {
  return await routeRead({
    label: 'patients',
    local: async () => {
      const [localPatients, localNhisClaimPatients] = await Promise.all([
        listBranchRecords('patients', { limit: 5000 }),
        listLocalNhisClaimPatients({ limit: 5000 }),
      ])
      const mergedLocalPatients = mergePatients(localPatients, localNhisClaimPatients)
      if (mergedLocalPatients.length || getConnectivityState().internetAvailable === false) {
        return mergedLocalPatients
      }

      try {
        return await fetchPatientsFromSupabase()
      } catch {
        return mergedLocalPatients
      }
    },
    cloud: fetchPatientsFromSupabase,
    fallback: [],
  })
}

// Get patient by ID
export const getPatientById = async (id) => {
  if (isNhisClaimPatientId(id)) {
    const claimKey = getNhisClaimKeyFromPatientId(id)
    return await routeRead({
      label: 'NHIS claim patient',
      local: async () => {
        const claims = await listBranchRecords('nhis/claims', { id: claimKey, limit: 1 })
        if (!claims.length) {
          throw new Error('NHIS claim patient not found in local branch server.')
        }
        return nhisClaimToPatientDetail(claims[0])
      },
      cloud: async () => {
        const query = supabase
          .from('nhis_claims')
          .select('*')

        const { data, error } = isPersistedSupabasePatientId(claimKey)
          ? await query.eq('id', claimKey).maybeSingle()
          : await query.eq('claim_number', claimKey).maybeSingle()

        if (error && error.code !== 'PGRST116') throw error
        if (!data) throw new Error('NHIS claim patient not found.')
        return nhisClaimToPatientDetail(data)
      },
      fallback: null,
    })
  }

  return await routeRead({
    label: 'patient',
    local: async () => {
      const patients = await listBranchRecords('patients', { id, limit: 1 })
      if (!patients.length) {
        throw new Error('Patient not found in local branch server.')
      }
      return patients[0]
    },
    cloud: async () => {
      const { data, error } = await supabase
        .from('patients')
        .select(`
          *,
          sales (
            *,
            sale_items (
              *,
              drugs (name)
            )
          ),
          claims (*)
        `)
        .eq('id', id)
        .single()

      if (error) throw error
      return data
    },
    fallback: null,
  })
}

const compactPatientLookup = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const patientMatchesSearch = (patient, term) => {
  const normalizedTerm = String(term || '').toLowerCase()
  const compactTerm = compactPatientLookup(term)
  if (!normalizedTerm && !compactTerm) return true

  return [
    patient?.full_name,
    patient?.phone,
    patient?.email,
    patient?.folder_no,
    patient?.insurance_provider,
    patient?.insurance_id,
    patient?.nhis_member_no,
    patient?.nhis_hin,
  ]
    .filter(Boolean)
    .some((value) => {
      const normalizedValue = String(value).toLowerCase()
      return normalizedValue.includes(normalizedTerm) ||
        (compactTerm && compactPatientLookup(value).includes(compactTerm))
    })
}

const patientSearchKey = (patient = {}) =>
  compactPatientLookup([
    patient.id,
    patient.full_name,
    patient.insurance_id,
    patient.nhis_member_no,
    patient.nhis_hin,
    patient.folder_no,
  ].filter(Boolean).join('|'))

const SUPABASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isPersistedSupabasePatientId = (id) => SUPABASE_UUID_PATTERN.test(String(id || '').trim())

const isNhisClaimPatientId = (id) => String(id || '').startsWith('nhis-claim-')

const getNhisClaimKeyFromPatientId = (id) =>
  String(id || '').replace(/^nhis-claim-/, '').trim()

const nhisClaimToPatient = (claim = {}) => ({
  id: claim.patient_id || `nhis-claim-${claim.id || claim.claim_number || compactPatientLookup([
    claim.member_no,
    claim.hin,
    claim.surname,
    claim.other_names,
  ].filter(Boolean).join('|'))}`,
  patient_id: claim.patient_id || '',
  full_name: [claim.surname, claim.other_names].filter(Boolean).join(' ').trim(),
  phone: claim.phone || '',
  email: claim.email || '',
  gender: claim.gender || '',
  date_of_birth: claim.date_of_birth || '',
  address: claim.patient_address || '',
  insurance_provider: claim.insurance_provider || 'NHIS',
  insurance_id: claim.member_no || '',
  nhis_member_no: claim.member_no || '',
  nhis_hin: claim.hin || '',
  folder_no: claim.folder_no || '',
  source_claim_number: claim.claim_number || '',
  sourceClaimNumber: claim.claim_number || '',
})

const getNhisClaimVisitDate = (claim = {}) =>
  claim.service_date || claim.service_date_from || claim.dispensing_date || claim.created_at || null

const patientMatchesNhisClaim = (patient = {}, claim = {}) => {
  const patientId = String(patient.id || patient.patient_id || '').trim()
  const claimPatientId = String(claim.patient_id || '').trim()
  if (patientId && claimPatientId && patientId === claimPatientId) return true

  const patientMember = compactPatientLookup(patient.nhis_member_no || patient.insurance_id)
  const claimMember = compactPatientLookup(claim.member_no || claim.insurance_id)
  if (patientMember && claimMember && patientMember === claimMember) return true

  const patientHin = compactPatientLookup(patient.nhis_hin)
  const claimHin = compactPatientLookup(claim.hin)
  if (patientHin && claimHin && patientHin === claimHin) return true

  const patientPhone = compactPatientLookup(patient.phone)
  const claimPhone = compactPatientLookup(claim.phone || claim.patient_phone)
  if (patientPhone && claimPhone && patientPhone === claimPhone) return true

  return false
}

const latestDateValue = (...values) =>
  values
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null

const nhisClaimToPatientDetail = (claim = {}) => ({
  ...nhisClaimToPatient(claim),
  sales: [],
  claims: [{
    id: claim.id || claim.claim_number,
    claim_number: claim.claim_number || '',
    claim_status: claim.claim_status || claim.status || '',
    service_date: claim.service_date || claim.service_date_from || claim.dispensing_date || '',
    total_amount: claim.total_amount || 0,
  }],
})

const fetchNhisClaimPatientsFromSupabase = async () => {
  const { data, error } = await supabase
    .from('nhis_claims')
    .select(NHIS_CLAIM_PATIENT_SELECT)
    .order('created_at', { ascending: false })
    .limit(NHIS_CLAIM_PATIENT_LOOKUP_LIMIT)

  if (error) throw error

  return (data || [])
    .map(nhisClaimToPatient)
    .filter((patient) => patient.full_name || patient.nhis_member_no || patient.nhis_hin || patient.insurance_id)
}

const mergePatients = (...groups) => {
  const merged = new Map()
  groups.flat().filter(Boolean).forEach((patient) => {
    const key = patientSearchKey(patient)
    if (!key) return
    const existing = merged.get(key)
    merged.set(key, existing
      ? {
          ...patient,
          ...existing,
          full_name: existing.full_name || patient.full_name || '',
          phone: existing.phone || patient.phone || '',
          nhis_member_no: existing.nhis_member_no || patient.nhis_member_no || '',
          nhis_hin: existing.nhis_hin || patient.nhis_hin || '',
          insurance_id: existing.insurance_id || patient.insurance_id || '',
          folder_no: existing.folder_no || patient.folder_no || '',
          sourceClaimNumber: existing.sourceClaimNumber || patient.sourceClaimNumber || '',
          source_claim_number: existing.source_claim_number || patient.source_claim_number || '',
        }
      : patient)
  })
  return [...merged.values()]
}

export const normalizePatientWorkspaceData = (workspace = {}) => {
  const nhisClaims = workspace.nhisClaims || []
  const claimPatients = (workspace.nhisClaims || [])
    .map(nhisClaimToPatient)
    .filter((patient) => patient.full_name || patient.nhis_member_no || patient.nhis_hin || patient.insurance_id)
  const visitStats = workspace.visitStats || {}

  return mergePatients(workspace.patients || [], claimPatients).map((patient) => {
    const stats = visitStats[patient.id] || {}
    const matchingNhisClaims = nhisClaims.filter((claim) => patientMatchesNhisClaim(patient, claim))
    const lastNhisVisit = latestDateValue(...matchingNhisClaims.map(getNhisClaimVisitDate))
    return {
      ...patient,
      visits: Number(stats.visits || 0) + matchingNhisClaims.length,
      lastVisit: latestDateValue(stats.lastVisit, lastNhisVisit),
    }
  })
}

const fetchPatientsWorkspaceFromCloud = async () =>
  normalizePatientWorkspaceData(
    await invokeTierAccess({ action: 'get_patients_workspace' })
  )

const listLocalNhisClaimPatients = async (filters = {}) => {
  const claims = await Promise.resolve(listBranchRecords('nhis/claims', filters)).catch(() => [])
  return (claims || [])
    .map(nhisClaimToPatient)
    .filter((patient) => patient.full_name || patient.nhis_member_no || patient.nhis_hin || patient.insurance_id)
}

export const getPatientsWorkspace = async () =>
  await routeRead({
    label: 'patient workspace',
    local: async () => {
      const [patients, nhisClaims] = await Promise.all([
        listBranchRecords('patients', { limit: 5000 }),
        Promise.resolve(listBranchRecords('nhis/claims', { limit: 5000 })).catch(() => []),
      ])
      const localWorkspace = normalizePatientWorkspaceData({ patients, nhisClaims })
      if (localWorkspace.length || getConnectivityState().internetAvailable === false) {
        return localWorkspace
      }

      try {
        return await fetchPatientsWorkspaceFromCloud()
      } catch {
        return localWorkspace
      }
    },
    cloud: fetchPatientsWorkspaceFromCloud,
    fallback: [],
  })

// Add new patient
export const addPatient = async (patientData) => {
  const fullName = assertRequiredText(patientData.fullName, 'Patient name')
  const phone = assertRequiredText(patientData.phone, 'Phone')
  const folderNo = assertRequiredText(patientData.folderNo || patientData.folder_no, 'Folder number')
  const insuranceProvider = normalizeText(patientData.insuranceProvider)
  const insuranceId = normalizeInsuranceId(insuranceProvider, patientData.insuranceId)

  const localCreate = async () =>
    await createBranchRecord('patients', {
      full_name: fullName,
      phone,
      folder_no: folderNo,
      email: normalizeText(patientData.email) || null,
      date_of_birth: patientData.dateOfBirth || null,
      gender: normalizeText(patientData.gender) || null,
      address: normalizeText(patientData.address) || null,
      insurance_provider: insuranceProvider || null,
      insurance_id: insuranceId || null,
      allergies: normalizeText(patientData.allergies) || null,
      medical_notes: normalizeText(patientData.medicalNotes) || null,
    })

  const cloudCreate = async () => {
    const { data, error } = await supabase
      .from('patients')
      .insert([
        {
          full_name: fullName,
          phone,
          folder_no: folderNo,
          email: normalizeText(patientData.email) || null,
          date_of_birth: patientData.dateOfBirth,
          gender: normalizeText(patientData.gender) || null,
          address: normalizeText(patientData.address) || null,
          insurance_provider: insuranceProvider || null,
          insurance_id: insuranceId || null,
          allergies: normalizeText(patientData.allergies) || null,
          medical_notes: normalizeText(patientData.medicalNotes) || null
        }
      ])
      .select()

    if (error) throwFriendlyPatientError(error)

    await tryLogAuditEvent({
      eventType: 'patient.created',
      entityType: 'patients',
      entityId: data[0].id,
      action: 'create',
      details: {
        full_name: data[0].full_name,
        phone: data[0].phone,
        insurance_provider: data[0].insurance_provider,
      },
    })

    return data[0]
  }

  return await routeWrite({
    label: 'patient',
    local: localCreate,
    cloud: cloudCreate,
  })
}

// Update patient
export const updatePatient = async (id, patientData) => {
  const fullName = assertRequiredText(patientData.fullName, 'Patient name')
  const phone = assertRequiredText(patientData.phone, 'Phone')
  const folderNo = assertRequiredText(patientData.folderNo || patientData.folder_no, 'Folder number')
  const insuranceProvider = normalizeText(patientData.insuranceProvider)
  const insuranceId = normalizeInsuranceId(insuranceProvider, patientData.insuranceId)

  const localUpdate = async () =>
    await updateBranchRecord('patients', id, {
      full_name: fullName,
      phone,
      folder_no: folderNo,
      email: normalizeText(patientData.email) || null,
      date_of_birth: patientData.dateOfBirth || null,
      gender: normalizeText(patientData.gender) || null,
      address: normalizeText(patientData.address) || null,
      insurance_provider: insuranceProvider || null,
      insurance_id: insuranceId || null,
      allergies: normalizeText(patientData.allergies) || null,
      medical_notes: normalizeText(patientData.medicalNotes) || null,
    })

  const cloudUpdate = async () => {
    const { data, error } = await supabase
      .from('patients')
      .update({
        full_name: fullName,
        phone,
        folder_no: folderNo,
        email: normalizeText(patientData.email) || null,
        date_of_birth: patientData.dateOfBirth,
        gender: normalizeText(patientData.gender) || null,
        address: normalizeText(patientData.address) || null,
        insurance_provider: insuranceProvider || null,
        insurance_id: insuranceId || null,
        allergies: normalizeText(patientData.allergies) || null,
        medical_notes: normalizeText(patientData.medicalNotes) || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()

    if (error) throwFriendlyPatientError(error)

    await tryLogAuditEvent({
      eventType: 'patient.updated',
      entityType: 'patients',
      entityId: id,
      action: 'update',
      details: {
        full_name: fullName,
        phone,
        insurance_provider: normalizeText(patientData.insuranceProvider) || null,
      },
    })

    return data[0]
  }

  return await routeWrite({
    label: 'patient update',
    local: localUpdate,
    cloud: cloudUpdate,
  })
}

// Search patients
export const searchPatients = async (searchTerm) => {
  const term = sanitizeSearchTerm(searchTerm)
  if (await shouldRouteToLocal()) {
    const localPatients = await listBranchRecords('patients', { searchTerm: term })
    const localNhisClaimPatients = await listLocalNhisClaimPatients({ searchTerm: term, limit: 100 })
    const mergedLocalPatients = mergePatients(localPatients, localNhisClaimPatients)
    if (mergedLocalPatients.length || getConnectivityState().internetAvailable === false) {
      return mergedLocalPatients
    }

    try {
      const cloudPatients = await fetchPatientsWorkspaceFromCloud()
      return cloudPatients.filter((patient) => patientMatchesSearch(patient, term))
    } catch {
      return mergedLocalPatients
    }
  }

  if (!term) {
    return getPatientsWorkspace()
  }

  const cloudPatients = await fetchPatientsWorkspaceFromCloud()
  return cloudPatients.filter((patient) => patientMatchesSearch(patient, term))
}

// Get patient visit count
export const getPatientVisitCount = async (patientId) => {
  if (!isPersistedSupabasePatientId(patientId)) {
    return 0
  }

  if (await shouldRouteToLocal()) {
    return 0
  }

  const { count, error } = await supabase
    .from('sales')
    .select('*', { count: 'exact', head: true })
    .eq('patient_id', patientId)
  
  if (error) throw error

  const { count: nhisCount, error: nhisError } = await supabase
    .from('nhis_claims')
    .select('*', { count: 'exact', head: true })
    .eq('patient_id', patientId)

  if (nhisError) throw nhisError
  return Number(count || 0) + Number(nhisCount || 0)
}

// Get patient last visit
export const getPatientLastVisit = async (patientId) => {
  if (!isPersistedSupabasePatientId(patientId)) {
    return null
  }

  if (await shouldRouteToLocal()) {
    return null
  }

  const { data, error } = await supabase
    .from('sales')
    .select('sale_date')
    .eq('patient_id', patientId)
    .order('sale_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  
  if (error && error.code !== 'PGRST116') throw error

  const { data: nhisData, error: nhisError } = await supabase
    .from('nhis_claims')
    .select('service_date_from, service_date, dispensing_date, created_at')
    .eq('patient_id', patientId)
    .order('service_date_from', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (nhisError && nhisError.code !== 'PGRST116') throw nhisError
  return latestDateValue(data?.sale_date, getNhisClaimVisitDate(nhisData || {}))
}
