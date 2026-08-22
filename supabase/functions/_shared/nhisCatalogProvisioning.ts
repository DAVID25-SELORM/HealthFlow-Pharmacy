// The browser NHIS catalog is the single canonical reference list. This
// server-side adapter uses it for tenant creation and safe tenant repairs.
import { DEFAULT_NHIS_DRUG_CATALOG } from '../../../src/data/nhisDefaultDrugCatalog.js'

const BATCH_SIZE = 200
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

type CatalogClient = { from: (table: string) => any }

export const provisionNhisCatalogForOrganization = async (
  client: CatalogClient,
  organizationId: string,
  options: { actorUserId?: string | null; source: string }
) => {
  const { data: existing, error: existingError } = await client
    .from('nhis_drugs')
    .select('id, code, description, unit, unit_price, is_active')
    .eq('organization_id', organizationId)

  if (existingError) throw existingError

  const existingByCode = new Map(
    (existing || [])
      .map((row: Record<string, unknown>) => [text(row.code).toUpperCase(), row])
      .filter(([code]: [string, Record<string, unknown>]) => Boolean(code))
  )
  const missingRows = DEFAULT_NHIS_DRUG_CATALOG
    .filter((row) => !existingByCode.has(text(row.code).toUpperCase()))
    .map((row) => ({
      organization_id: organizationId,
      code: text(row.code).toUpperCase(),
      description: text(row.description),
      unit: text(row.unit) || 'unit',
      unit_price: Number(row.unit_price || 0),
      category: text(row.category) || null,
      is_active: true,
    }))

  for (let index = 0; index < missingRows.length; index += BATCH_SIZE) {
    const { error } = await client.from('nhis_drugs').insert(missingRows.slice(index, index + BATCH_SIZE))
    if (error) throw error
  }

  const inactiveCodes = [...existingByCode.values()]
    .filter((row: Record<string, unknown>) => row.is_active === false)
    .map((row: Record<string, unknown>) => text(row.code).toUpperCase())
  const incompleteCodes = [...existingByCode.values()]
    .filter((row: Record<string, unknown>) =>
      !text(row.description) || !text(row.unit) || !Number.isFinite(Number(row.unit_price)) || Number(row.unit_price) < 0
    )
    .map((row: Record<string, unknown>) => text(row.code).toUpperCase())
  const result = {
    source: options.source,
    expectedCount: DEFAULT_NHIS_DRUG_CATALOG.length,
    existingCount: (existing || []).length,
    insertedCodes: missingRows.map((row) => row.code),
    inactiveCodes,
    incompleteCodes,
  }

  if (options.actorUserId && missingRows.length) {
    await client.from('audit_logs').insert({
      actor_user_id: options.actorUserId,
      event_type: 'nhis_catalog.provisioned',
      entity_type: 'nhis_drugs',
      entity_id: null,
      action: 'insert_missing_catalog_rows',
      organization_id: organizationId,
      details: result,
    }).then(({ error }: { error: unknown }) => {
      if (error) console.warn('NHIS catalog provisioning audit warning:', error)
    })
  }

  return result
}
