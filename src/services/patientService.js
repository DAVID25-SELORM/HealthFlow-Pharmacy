import { supabase } from '../lib/supabase'

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
  const { data, error } = await supabase
    .from('patients')
    .insert([
      {
        full_name: patientData.fullName,
        phone: patientData.phone,
        email: patientData.email,
        date_of_birth: patientData.dateOfBirth,
        gender: patientData.gender,
        address: patientData.address,
        insurance_provider: patientData.insuranceProvider,
        insurance_id: patientData.insuranceId,
        allergies: patientData.allergies,
        medical_notes: patientData.medicalNotes
      }
    ])
    .select()
  
  if (error) throw error
  return data[0]
}

// Update patient
export const updatePatient = async (id, patientData) => {
  const { data, error } = await supabase
    .from('patients')
    .update({
      full_name: patientData.fullName,
      phone: patientData.phone,
      email: patientData.email,
      date_of_birth: patientData.dateOfBirth,
      gender: patientData.gender,
      address: patientData.address,
      insurance_provider: patientData.insuranceProvider,
      insurance_id: patientData.insuranceId,
      allergies: patientData.allergies,
      medical_notes: patientData.medicalNotes,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
  
  if (error) throw error
  return data[0]
}

// Search patients
export const searchPatients = async (searchTerm) => {
  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .or(`full_name.ilike.%${searchTerm}%,phone.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`)
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
