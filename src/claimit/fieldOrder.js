import { orderedRecord } from './compatibility'
import may from './may-reference-contract.json'

// Canonical orders are taken from the genuine May Claim-IT export. No unverified
// local June artifact is treated as acceptance evidence.
// Table/column order comes from the JSON contract's ordered _dbstruct schema.
export const TABLE_FIELD_ORDER = Object.freeze(Object.fromEntries(
  Object.entries(may.schema).map(([table, columns]) => [table, Object.keys(columns)]),
))
export const TOP_LEVEL_ORDER = Object.freeze(["lockID","dateGenerated","signedByName","signedByUsername","signedByRole","data","isBackup","isExport","isPartial","periodStart","periodEnd"])
export const SECTION_ORDER = Object.freeze(["claims","serviceentries","medicineentries","summaryitems","attachmentdata","attachments","comments","validations","validation_results","validation_zclaims","prescribersfordays","_meta","_dbstruct"])
export const APP_VERSION_ORDER = Object.freeze(Object.keys(may.appVersion))
export const ACCREDITATION_FIELD_ORDER = Object.freeze(['accred_effectiveDate','accred_providerID','facilityTypeCode','ownershipTypeCode','cateringStatusCode','prescriptionLevelID','facilityName','dateGenerated','expiryDate','credentialCode'])
export const METADATA_PREFIX_ORDER = Object.freeze(['dbVersions','claimYear','claimMonth','claimType','facilityName','providerLevel','providerID','credentialCode','policies','medVersions','servVersions','appVersion','accreditations','credUsage'])

function orderPresent(record, fields) {
  if (Object.keys(record).some((key) => !fields.includes(key))) throw new Error('Unexpected Claim-IT field')
  return orderedRecord(record, fields.filter((key) => Object.hasOwn(record, key)))
}

export function canonicalizeBundle(bundle) {
  const data = orderedRecord(bundle.data, SECTION_ORDER)
  for (const section of SECTION_ORDER) {
    if (section.startsWith('_')) continue
    data[section] = data[section].map((row) => orderPresent(row, TABLE_FIELD_ORDER[section]))
  }
  data._dbstruct = orderedRecord(data._dbstruct, Object.keys(TABLE_FIELD_ORDER))
  for (const [table, fields] of Object.entries(TABLE_FIELD_ORDER)) data._dbstruct[table] = orderedRecord(data._dbstruct[table], fields)
  data._meta.appVersion = orderedRecord(data._meta.appVersion, APP_VERSION_ORDER)
  data._meta.accreditations = data._meta.accreditations.map((row) => orderedRecord(row, ACCREDITATION_FIELD_ORDER))
  const serviceTypes = [...new Set(data.claims.map((claim) => claim.typeOfService))].sort()
  data._meta = orderedRecord(data._meta, [...METADATA_PREFIX_ORDER,...serviceTypes,'totalVol','totalCost','totalExceptions'])
  return orderedRecord({ ...bundle, data }, TOP_LEVEL_ORDER)
}
