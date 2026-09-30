import { supabase } from '../lib/supabase'
import { hasRole, NHIS_ROLES, INVENTORY_ROLES, PATIENT_ROLES, SALES_ROLES, CLAIMS_ROLES } from '../utils/roles'

export const searchSources = [
  { key: 'nhis', table: 'nhis_claims', label: 'NHIS claims', path: '/nhis', fields: ['claim_number', 'ccc_no', 'folder_no', 'member_no', 'hin', 'surname', 'other_names', 'prescription_reference'], extra: ['branch_id', 'status', 'service_date_from'], title: 'claim_number' },
  { key: 'inventory', table: 'drugs', label: 'Inventory', path: '/inventory', fields: ['name', 'brand_name', 'generic_name', 'batch_number', 'nhis_code', 'category', 'supplier'], extra: ['branch_id', 'quantity', 'unit', 'status'], title: 'name' },
  { key: 'patients', table: 'patients', label: 'Patients', path: '/patients', fields: ['full_name', 'phone', 'email', 'insurance_id', 'nhis_member_no', 'nhis_hin'], extra: [], title: 'full_name' },
  { key: 'purchases', table: 'purchases', label: 'Purchases / invoices', path: '/purchases', fields: ['purchase_number', 'invoice_number', 'supplier_name'], extra: ['branch_id', 'purchase_date', 'status', 'total_amount'], title: 'purchase_number' },
  { key: 'suppliers', table: 'suppliers', label: 'Suppliers', path: '/purchases', fields: ['name', 'contact_person', 'phone', 'email', 'address'], extra: [], title: 'name' },
  { key: 'sales', table: 'sales', label: 'Sales', path: '/sales', fields: ['sale_number', 'payment_method', 'notes'], extra: ['branch_id', 'sale_date', 'net_amount'], title: 'sale_number' },
  { key: 'claims', table: 'claims', label: 'Insurance claims', path: '/claims', fields: ['claim_number', 'patient_name', 'insurance_id', 'insurance_provider'], extra: ['claim_status', 'service_date', 'branch_id'], title: 'claim_number' },
]

export const allowedSearchSources = (auth, tenant) => {
  const clinical = tenant.organization?.organization_type !== 'chemical_shop'
  const purchases = tenant.canUsePurchases && (hasRole(auth.role, ['admin', 'super_admin']) || auth.canManagePurchases)
  const access = {
    nhis: clinical && tenant.canUseNhis && hasRole(auth.role, NHIS_ROLES),
    inventory: auth.canManageInventory || hasRole(auth.role, INVENTORY_ROLES),
    patients: clinical && (auth.canManagePatients || hasRole(auth.role, PATIENT_ROLES)),
    purchases, suppliers: purchases,
    sales: auth.canProcessSales || hasRole(auth.role, SALES_ROLES),
    claims: clinical && tenant.canUseClaims && (auth.canManageClaims || hasRole(auth.role, CLAIMS_ROLES)),
  }
  return searchSources.filter((source) => access[source.key])
}

export const searchFacilityRecords = async ({ term, organizationId, sources, signal }) => {
  const words = String(term || '').slice(0, 120).replace(/[^\p{L}\p{N}\s@+-]/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8)
  if (!organizationId || words.join('').length < 2) return []
  return Promise.all(sources.map(async (source) => {
    try {
      let query = supabase.from(source.table).select(['id', ...source.fields, ...source.extra].join(','))
        .eq('organization_id', organizationId)
      for (const word of words) query = query.or(source.fields.map((field) => `${field}.ilike.%${word}%`).join(','))
      query = query.order(source.title).order('id').limit(26)
      if (signal) query = query.abortSignal(signal)
      const { data, error } = await query
      if (error) throw error
      return { ...source, rows: (data || []).slice(0, 25), more: (data || []).length > 25 }
    } catch (error) {
      return { ...source, rows: [], error: error.message || 'Search unavailable. Please try again.' }
    }
  }))
}
