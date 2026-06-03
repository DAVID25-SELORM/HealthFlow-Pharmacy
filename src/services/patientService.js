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

const PATIENT_INSURANCE_ID_UNIQUE_CONSTRAINTS = [
  'idx_patients_org_insurance_id_unique',
  'idx_patients_org_nhis_member_no_unique',
  'idx_patients_org_nhis_hin_unique',
]

const PATIENT_INSURANCE_ID_FIELDS = ['insurance_id', 'nhis_member_no', 'nhis_hin']

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
  return data || []
}

const searchPatientsFromSupabase = async (term) => {
  if (!term) {
    return fetchPatientsFromSupabase()
  }

  const compactTerm = compactPatientLookup(term)
  const searchTerms = [...new Set([term, compactTerm].filter(Boolean))]
  const searchFilters = searchTerms.flatMap((value) => [
    `full_name.ilike.%${value}%`,
    `phone.ilike.%${value}%`,
    `email.ilike.%${value}%`,
    `insurance_provider.ilike.%${value}%`,
    `insurance_id.ilike.%${value}%`,
    `nhis_member_no.ilike.%${value}%`,
    `nhis_hin.ilike.%${value}%`,
  ])

  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .or(searchFilters.join(','))
    .order('full_name')

  if (error) throw error

  const rows = data || []
  if (compactTerm === term) {
    return rows
  }

  const allPatients = await fetchPatientsFromSupabase()
  const merged = new Map(rows.map((patient) => [patient.id, patient]))
  allPatients
    .filter((patient) => patientMatchesSearch(patient, term))
    .forEach((patient) => merged.set(patient.id, patient))

  return [...merged.values()].sort((left, right) =>
    String(left.full_name || '').localeCompare(String(right.full_name || ''))
  )
}

// Get all patients
export const getAllPatients = async () => {
  return await routeRead({
    label: 'patients',
    local: async () => {
      const localPatients = await listBranchRecords('patients')
      if (localPatients.length || getConnectivityState().internetAvailable === false) {
        return localPatients
      }

      try {
        return await fetchPatientsFromSupabase()
      } catch {
        return localPatients
      }
    },
    cloud: fetchPatientsFromSupabase,
    fallback: [],
  })
}

// Get patient by ID
export const getPatientById = async (id) => {
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

// Add new patient
export const addPatient = async (patientData) => {
  const fullName = assertRequiredText(patientData.fullName, 'Patient name')
  const phone = assertRequiredText(patientData.phone, 'Phone')
  const insuranceProvider = normalizeText(patientData.insuranceProvider)
  const insuranceId = normalizeInsuranceId(insuranceProvider, patientData.insuranceId)

  const localCreate = async () =>
    await createBranchRecord('patients', {
      full_name: fullName,
      phone,
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
  const insuranceProvider = normalizeText(patientData.insuranceProvider)
  const insuranceId = normalizeInsuranceId(insuranceProvider, patientData.insuranceId)

  const localUpdate = async () =>
    await updateBranchRecord('patients', id, {
      full_name: fullName,
      phone,
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
    if (localPatients.length || getConnectivityState().internetAvailable === false) {
      return localPatients
    }

    try {
      return await searchPatientsFromSupabase(term)
    } catch {
      return localPatients
    }
  }

  if (!term) {
    return getAllPatients()
  }

  return searchPatientsFromSupabase(term)
}

// Get patient visit count
export const getPatientVisitCount = async (patientId) => {
  if (await shouldRouteToLocal()) {
    return 0
  }

  const { count, error } = await supabase
    .from('sales')
    .select('*', { count: 'exact', head: true })
    .eq('patient_id', patientId)
  
  if (error) throw error
  return count
}

// Get patient last visit
export const getPatientLastVisit = async (patientId) => {
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
  return data?.sale_date || null
}
