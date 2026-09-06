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
const PATIENT_TYPEAHEAD_LIMIT = 80
const NHIS_CLAIM_PATIENT_TYPEAHEAD_LIMIT = 120

const NHIS_CLAIM_PATIENT_SELECT = [
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

const NHIS_CLAIM_PATIENT_MINIMAL_SELECT = [
  'id',
  'claim_number',
  'patient_id',
  'member_no',
  'hin',
  'surname',
  'other_names',
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
        listBranchRecords('patients', { limit: 100000 }),
        listLocalNhisClaimPatients({ limit: 100000 }),
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
        const selectedClaim = claims[0]
        const lookup = selectedClaim.member_no || selectedClaim.hin || selectedClaim.patient_id || selectedClaim.folder_no
        const historyClaims = lookup
          ? await listBranchRecords('nhis/claims', { searchTerm: lookup, limit: 500 })
          : claims
        const matchingClaims = historyClaims.filter((claim) =>
          patientMatchesNhisClaim(nhisClaimToPatient(selectedClaim), claim)
        )
        return nhisClaimsToPatientDetail(
          selectedClaim,
          matchingClaims.length ? matchingClaims : claims
        )
      },
      cloud: async () => {
        const query = supabase
          .from('nhis_claims')
          .select('*, nhis_claim_medicines (*)')

        const { data, error } = isPersistedSupabasePatientId(claimKey)
          ? await query.eq('id', claimKey).maybeSingle()
          : await query.eq('claim_number', claimKey).maybeSingle()

        if (error && error.code !== 'PGRST116') throw error
        if (!data) throw new Error('NHIS claim patient not found.')

        const historyQueries = []
        if (data.patient_id) {
          historyQueries.push(fetchCloudNhisClaimHistory('patient_id', data.patient_id))
        }
        if (data.member_no) {
          historyQueries.push(fetchCloudNhisClaimHistory('member_no', data.member_no))
        }
        if (data.hin) {
          historyQueries.push(fetchCloudNhisClaimHistory('hin', data.hin))
        }
        if (data.folder_no) {
          historyQueries.push(fetchCloudNhisClaimHistory('folder_no', data.folder_no))
        }
        const historyGroups = historyQueries.length
          ? await Promise.all(historyQueries)
          : [[data]]
        const historyClaims = dedupeClaims([...historyGroups.flat(), data])
          .filter((claim) => patientMatchesNhisClaim(nhisClaimToPatient(data), claim))
        return nhisClaimsToPatientDetail(data, historyClaims)
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
      const patient = patients[0]
      const lookup = patient.nhis_member_no || patient.insurance_id || patient.nhis_hin
      const nhisClaims = lookup
        ? (await listBranchRecords('nhis/claims', { searchTerm: lookup, limit: 500 }))
          .filter((claim) => patientMatchesNhisClaim(patient, claim))
        : []
      return mergePatientHistory(patient, nhisClaims)
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
          claims (
            *,
            claim_items (*)
          )
        `)
        .eq('id', id)
        .single()

      if (error) throw error
      const historyQueries = [
        fetchCloudNhisClaimHistory('patient_id', id),
      ]
      if (data.nhis_member_no || data.insurance_id) {
        historyQueries.push(fetchCloudNhisClaimHistory(
          'member_no',
          data.nhis_member_no || data.insurance_id
        ))
      }
      if (data.nhis_hin) {
        historyQueries.push(fetchCloudNhisClaimHistory('hin', data.nhis_hin))
      }
      if (data.folder_no) {
        historyQueries.push(fetchCloudNhisClaimHistory('folder_no', data.folder_no))
      }
      const nhisClaims = dedupeClaims((await Promise.all(historyQueries)).flat())
        .filter((claim) => patientMatchesNhisClaim(data, claim))
      return mergePatientHistory(data, nhisClaims)
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

const patientIdentityAliases = (patient = {}) => {
  const aliases = []
  const add = (prefix, value) => {
    const normalized = compactPatientLookup(value)
    if (normalized) aliases.push(`${prefix}:${normalized}`)
  }

  add('id', patient.patient_id || patient.id)
  add('member', patient.nhis_member_no || patient.insurance_id || patient.member_no)
  add('hin', patient.nhis_hin || patient.hin)
  if (patient.folder_no && patient.full_name) {
    add('folder-name', `${patient.folder_no}|${patient.full_name}`)
  }
  if (patient.full_name && patient.date_of_birth) {
    add('name-dob', `${patient.full_name}|${patient.date_of_birth}`)
  }
  return aliases
}

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

  const patientName = compactPatientLookup(patient.full_name || [patient.surname, patient.other_names].filter(Boolean).join(' '))
  const claimName = compactPatientLookup(claim.full_name || [claim.surname, claim.other_names].filter(Boolean).join(' '))
  const patientFolder = compactPatientLookup(patient.folder_no)
  const claimFolder = compactPatientLookup(claim.folder_no)
  if (patientFolder && claimFolder && patientFolder === claimFolder && patientName && claimName && patientName === claimName) {
    return true
  }

  const patientDateOfBirth = String(patient.date_of_birth || patient.dateOfBirth || '').trim()
  const claimDateOfBirth = String(claim.date_of_birth || claim.dateOfBirth || '').trim()
  if (patientDateOfBirth && claimDateOfBirth && patientDateOfBirth === claimDateOfBirth && patientName && claimName && patientName === claimName) {
    return true
  }

  return false
}

const latestDateValue = (...values) =>
  values
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null

const nhisClaimToHistoryClaim = (claim = {}) => ({
  id: claim.id || claim.claim_number,
  claim_number: claim.claim_number || '',
  claim_status: claim.claim_status || claim.status || '',
  service_date: claim.service_date || claim.service_date_from || claim.dispensing_date || claim.created_at || '',
  total_amount: claim.total_amount || 0,
  claim_type: 'nhis',
  medicines: claim.nhis_claim_medicines || claim.medicines || [],
})

const generalClaimToHistoryClaim = (claim = {}) => ({
  ...claim,
  claim_status: claim.claim_status || claim.status || '',
  service_date: claim.service_date || claim.created_at || '',
  claim_type: claim.claim_type || 'insurance',
  medicines: claim.claim_items || claim.items || claim.medicines || [],
})

const dedupeClaims = (claims = []) => {
  const rows = new Map()
  claims.filter(Boolean).forEach((claim) => {
    const key = String(claim.id || claim.claim_number || '').trim()
    if (key && !rows.has(key)) rows.set(key, claim)
  })
  return [...rows.values()]
}

const sortHistoryClaims = (claims = []) =>
  [...claims].sort(
    (left, right) =>
      new Date(getNhisClaimVisitDate(right) || 0) -
      new Date(getNhisClaimVisitDate(left) || 0)
  )

const fetchCloudNhisClaimHistory = async (column, value) => {
  if (!value) return []
  const { data, error } = await supabase
    .from('nhis_claims')
    .select('*, nhis_claim_medicines (*)')
    .eq(column, value)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  return data || []
}

const mergePatientHistory = (patient = {}, nhisClaims = []) => ({
  ...patient,
  claims: [
    ...(patient.claims || []).map(generalClaimToHistoryClaim),
    ...sortHistoryClaims(nhisClaims).map(nhisClaimToHistoryClaim),
  ],
})

const nhisClaimsToPatientDetail = (claim = {}, claims = [claim]) => ({
  ...nhisClaimToPatient(claim),
  sales: [],
  claims: sortHistoryClaims(dedupeClaims(claims)).map(nhisClaimToHistoryClaim),
})

const fetchNhisClaimPatientsFromSupabase = async () => {
  const fetchClaimPatients = async (selectColumns) => await supabase
    .from('nhis_claims')
    .select(selectColumns)
    .order('created_at', { ascending: false })
    .limit(NHIS_CLAIM_PATIENT_LOOKUP_LIMIT)

  let { data, error } = await fetchClaimPatients(NHIS_CLAIM_PATIENT_SELECT)
  if (error) {
    const fallback = await fetchClaimPatients(NHIS_CLAIM_PATIENT_MINIMAL_SELECT)
    data = fallback.data
    error = fallback.error
  }

  if (error) throw error

  return (data || [])
    .map(nhisClaimToPatient)
    .filter((patient) => patient.full_name || patient.nhis_member_no || patient.nhis_hin || patient.insurance_id)
}

const mergePatients = (...groups) => {
  const merged = []
  const aliasOwners = new Map()
  groups.flat().filter(Boolean).forEach((patient) => {
    const aliases = patientIdentityAliases(patient)
    if (!aliases.length) return
    const existingIndex = aliases
      .map((alias) => aliasOwners.get(alias))
      .find((index) => index !== undefined)
    const index = existingIndex ?? merged.length
    const existing = merged[index]
    merged[index] = existing
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
      : patient
    patientIdentityAliases(merged[index]).forEach((alias) => aliasOwners.set(alias, index))
    aliases.forEach((alias) => aliasOwners.set(alias, index))
  })
  return merged
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
    const serverVisitCount = Number(stats.visits)
    return {
      ...patient,
      // Cloud visitStats already includes NHIS claims and sales. Adding the
      // matching claim list again inflated the total while history stayed
      // correctly deduplicated (for example, 2 visits but one claim shown).
      visits: Number.isFinite(serverVisitCount)
        ? Math.max(serverVisitCount, 0)
        : matchingNhisClaims.length,
      lastVisit: latestDateValue(stats.lastVisit, lastNhisVisit),
    }
  })
}

const fetchPatientsWorkspaceFromCloud = async () =>
  normalizePatientWorkspaceData(
    await invokeTierAccess({ action: 'get_patients_workspace' })
  )

const normalizePatientsPageOptions = (options = {}) => {
  const page = Math.max(Number.parseInt(String(options.page || 1), 10) || 1, 1)
  const pageSize = Math.min(
    Math.max(Number.parseInt(String(options.pageSize || 100), 10) || 100, 1),
    500
  )
  return {
    page,
    pageSize,
    searchTerm: sanitizeSearchTerm(options.searchTerm || ''),
  }
}

const slicePatientPage = (rows = [], { page, pageSize }) => {
  const from = (page - 1) * pageSize
  return rows.slice(from, from + pageSize)
}

export const normalizePatientWorkspacePageData = (workspace = {}, fallback = {}) => {
  const options = normalizePatientsPageOptions(fallback)
  const patients = normalizePatientWorkspaceData(workspace).slice(0, options.pageSize)
  const reportedTotal = Number(workspace.total)
  return {
    patients,
    total: Number.isFinite(reportedTotal)
      ? Math.max(reportedTotal, patients.length)
      : patients.length,
    page: Number(workspace.page || options.page),
    pageSize: Number(workspace.pageSize || options.pageSize),
  }
}

const fetchPatientsWorkspacePageFromCloud = async (options = {}) => {
  const normalized = normalizePatientsPageOptions(options)
  return normalizePatientWorkspacePageData(
    await invokeTierAccess({
      action: 'get_patients_workspace',
      page: normalized.page,
      pageSize: normalized.pageSize,
      searchTerm: normalized.searchTerm || undefined,
    }),
    normalized
  )
}

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
        listBranchRecords('patients', { limit: 100000 }),
        Promise.resolve(listBranchRecords('nhis/claims', { limit: 100000 })).catch(() => []),
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

export const getPatientsWorkspacePage = async (options = {}) => {
  const normalized = normalizePatientsPageOptions(options)
  return await routeRead({
    label: 'patient workspace page',
    local: async () => {
      const [patients, nhisClaims] = await Promise.all([
        listBranchRecords('patients', {
          limit: 100000,
          searchTerm: normalized.searchTerm || undefined,
        }),
        Promise.resolve(listBranchRecords('nhis/claims', {
          limit: 100000,
          searchTerm: normalized.searchTerm || undefined,
        })).catch(() => []),
      ])
      const localPatients = normalizePatientWorkspaceData({ patients, nhisClaims })
      if (localPatients.length || getConnectivityState().internetAvailable === false) {
        const pagePatients = slicePatientPage(localPatients, normalized)
        return {
          patients: pagePatients,
          total: localPatients.length,
          page: normalized.page,
          pageSize: normalized.pageSize,
        }
      }

      try {
        return await fetchPatientsWorkspacePageFromCloud(normalized)
      } catch {
        return {
          patients: [],
          total: 0,
          page: normalized.page,
          pageSize: normalized.pageSize,
        }
      }
    },
    cloud: async () => await fetchPatientsWorkspacePageFromCloud(normalized),
    fallback: {
      patients: [],
      total: 0,
      page: normalized.page,
      pageSize: normalized.pageSize,
    },
  })
}

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
    const localPatients = await listBranchRecords('patients', {
      searchTerm: term,
      limit: PATIENT_TYPEAHEAD_LIMIT,
    })
    const localNhisClaimPatients = await listLocalNhisClaimPatients({
      searchTerm: term,
      limit: NHIS_CLAIM_PATIENT_TYPEAHEAD_LIMIT,
    })
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
    .select('service_date_from, created_at')
    .eq('patient_id', patientId)
    .order('service_date_from', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (nhisError && nhisError.code !== 'PGRST116') throw nhisError
  return latestDateValue(data?.sale_date, getNhisClaimVisitDate(nhisData || {}))
}
