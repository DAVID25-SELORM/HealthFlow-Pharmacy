import { supabase } from '../lib/supabase'
import { assertRequiredText, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'

/**
 * Patient Service
 * Handles all patient-related operations
 */

// Get all patients
export const getAllPatients = async () => {
  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .order('created_at', { ascending: false })
  
  if (error) throw error
  return data
}

// Get patient by ID
export const getPatientById = async (id) => {
  const { data, error } = await supabase
    .from('patients')
    .select(`
      *,
      sales (*),
      claims (*)
    `)
    .eq('id', id)
    .single()
  
  if (error) throw error
  return data
}

// Add new patient
export const addPatient = async (patientData) => {
  const fullName = assertRequiredText(patientData.fullName, 'Patient name')
  const phone = assertRequiredText(patientData.phone, 'Phone')

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
        insurance_provider: normalizeText(patientData.insuranceProvider) || null,
        insurance_id: normalizeText(patientData.insuranceId) || null,
        allergies: normalizeText(patientData.allergies) || null,
        medical_notes: normalizeText(patientData.medicalNotes) || null
      }
    ])
    .select()
  
  if (error) throw error

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

// Update patient
export const updatePatient = async (id, patientData) => {
  const fullName = assertRequiredText(patientData.fullName, 'Patient name')
  const phone = assertRequiredText(patientData.phone, 'Phone')

  const { data, error } = await supabase
    .from('patients')
    .update({
      full_name: fullName,
      phone,
      email: normalizeText(patientData.email) || null,
      date_of_birth: patientData.dateOfBirth,
      gender: normalizeText(patientData.gender) || null,
      address: normalizeText(patientData.address) || null,
      insurance_provider: normalizeText(patientData.insuranceProvider) || null,
      insurance_id: normalizeText(patientData.insuranceId) || null,
      allergies: normalizeText(patientData.allergies) || null,
      medical_notes: normalizeText(patientData.medicalNotes) || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
  
  if (error) throw error

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

// Search patients
export const searchPatients = async (searchTerm) => {
  const term = sanitizeSearchTerm(searchTerm)
  if (!term) {
    return getAllPatients()
  }

  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .or(`full_name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`)
    .order('full_name')
  
  if (error) throw error
  return data
}

// Get patient visit count
export const getPatientVisitCount = async (patientId) => {
  const { count, error } = await supabase
    .from('sales')
    .select('*', { count: 'exact', head: true })
    .eq('patient_id', patientId)
  
  if (error) throw error
  return count
}

// Get patient last visit
export const getPatientLastVisit = async (patientId) => {
  const { data, error } = await supabase
    .from('sales')
    .select('sale_date')
    .eq('patient_id', patientId)
    .order('sale_date', { ascending: false })
    .limit(1)
    .single()
  
  if (error && error.code !== 'PGRST116') throw error
  return data?.sale_date || null
}
