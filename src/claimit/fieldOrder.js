import { orderedRecord, CLAIM_IT_CLAIM_FIELD_ORDER } from './compatibility'

// Explicit orders extracted from the genuine May CXF schema, including empty tables.
export const TABLE_FIELD_ORDER = Object.freeze({
  "accreditations": [
    "uid",
    "prescriptionLevelID",
    "facilityName",
    "dateGenerated",
    "expiryDate",
    "isTemporary",
    "meta",
    "effectiveDate",
    "providerID",
    "ccd_agencyCode",
    "ccd_regionCode",
    "ccd_districtCode",
    "ccd_ownershipCode",
    "ccd_sequenceNumber",
    "ccd_facilityTypeCode",
    "ccd_prescriptionLevelCode",
    "ccd_cateringStatusCode",
    "ccd_effectiveDate",
    "facilityTypeCode",
    "ownershipTypeCode",
    "cateringStatusCode"
  ],
  "attachmentdata": [
    "_data_id",
    "_attach_id",
    "data"
  ],
  "attachments": [
    "attach_id",
    "_claim_id",
    "type",
    "fileType",
    "comments"
  ],
  "attendanceentries": [
    "_entry_id",
    "_claim_id",
    "claimType",
    "attdate",
    "ccc"
  ],
  "attendances": [
    "attdate",
    "ccc",
    "expiryDate",
    "data",
    "claimType",
    "memberNo",
    "cardSerialNo",
    "surname",
    "otherNames",
    "dateOfBirth",
    "gender",
    "hospitalRecNo",
    "isDependant",
    "generatedOn",
    "generatedByname",
    "generatedByuserID",
    "generatedByrole",
    "addedOn",
    "addedByname",
    "addedByuserID",
    "addedByrole",
    "modifiedOn",
    "modifiedByname",
    "modifiedByuserID",
    "modifiedByrole"
  ],
  "cateringstatuses": [
    "description",
    "accredCode",
    "statusCode"
  ],
  "claims": CLAIM_IT_CLAIM_FIELD_ORDER,
  "comments": [
    "_entry_id",
    "_claim_id",
    "comment",
    "createdOn",
    "createdByname",
    "createdByuserID",
    "createdByrole"
  ],
  "contracts": [
    "scheme",
    "facilityName",
    "dateGenerated",
    "expiryDate",
    "isTemporary",
    "data",
    "meta",
    "effectiveDate",
    "providerID",
    "contractCode"
  ],
  "diseases": [
    "_id",
    "icd10",
    "gender",
    "ageGroup",
    "sanitizedDescription",
    "description"
  ],
  "doctrine_migration_versions": [
    "version",
    "executed_at",
    "execution_time"
  ],
  "facilitytypes": [
    "description",
    "accredCode",
    "typeCode"
  ],
  "gdrgs": [
    "code",
    "description",
    "MDCCode",
    "GDRGNo",
    "split",
    "prefix",
    "suffix"
  ],
  "gdrgs_icd10s": [
    "code",
    "icd10"
  ],
  "icd10s": [
    "icd10",
    "description"
  ],
  "mdcs": [
    "code",
    "description"
  ],
  "medicineclasses": [
    "_entry_id",
    "_med_code",
    "major",
    "minor"
  ],
  "medicineentries": [
    "_entry_id",
    "_claim_id",
    "medicineCode",
    "serviceDate",
    "cost",
    "qty",
    "dispensedQty",
    "dispensaryUnit",
    "extraDirections",
    "unparsed",
    "dose_value",
    "dose_unit",
    "frequency_value",
    "frequency_unit",
    "frequency_desc",
    "duration_value",
    "duration_unit",
    "duration_desc"
  ],
  "medicineprices": [
    "uid",
    "price",
    "pricingUnit",
    "maxDosage",
    "flags",
    "prescriptionUnits",
    "dispensaryUnits",
    "buildVersion",
    "effectiveDate",
    "prescriptionLevelCode",
    "medicineCode"
  ],
  "medicines": [
    "code",
    "description"
  ],
  "ownerships": [
    "description",
    "accredCode",
    "ownershipCode"
  ],
  "policies": [
    "uid",
    "description",
    "buildVersion",
    "effectiveDate",
    "type"
  ],
  "policyrules": [
    "_id",
    "_policy_id",
    "position",
    "name",
    "outcome",
    "version",
    "runAt"
  ],
  "prescribersfordays": [
    "_id",
    "day",
    "name",
    "role"
  ],
  "prescriptionlevels": [
    "rank",
    "description",
    "levelCode"
  ],
  "providerlevels": [
    "uid",
    "description",
    "facilityTypeCode",
    "ownershipTypeCode",
    "cateringStatusCode"
  ],
  "rules": [
    "uid",
    "codeScript",
    "scope",
    "description",
    "category",
    "name",
    "outcome",
    "version",
    "runAt"
  ],
  "serviceentries": [
    "_entry_id",
    "_claim_id",
    "gdrgCode",
    "cost",
    "entryType",
    "serviceDate",
    "icd10",
    "description",
    "suggestedICD10"
  ],
  "servicetariffs": [
    "uid",
    "cost",
    "flags",
    "buildVersion",
    "effectiveDate",
    "facilityTypeCode",
    "ownershipTypeCode",
    "cateringStatusCode",
    "MDCCode",
    "GDRGNo",
    "split",
    "prefix",
    "suffix"
  ],
  "summaryitems": [
    "_entry_id",
    "_claim_id",
    "type",
    "ordinal",
    "description",
    "amount"
  ],
  "systemupdates": [
    "uid",
    "installDate",
    "hash",
    "buildVersion",
    "updateType",
    "updateVersion"
  ],
  "users": [
    "username",
    "name",
    "role",
    "password",
    "status",
    "officesanitizedName",
    "officename"
  ],
  "validation_results": [
    "_id",
    "_validation_id",
    "ruleID",
    "info",
    "entryID"
  ],
  "validation_zclaims": [
    "_id",
    "_validation_id",
    "serializedClaim",
    "isCompressed"
  ],
  "validations": [
    "_id",
    "s_id",
    "claimID",
    "policyID",
    "runTime",
    "outcome",
    "isSavedClaim",
    "memberNo",
    "firstDOSP",
    "lastDOSP",
    "runOn",
    "runByname",
    "runByuserID",
    "runByrole"
  ]
})
export const TOP_LEVEL_ORDER = Object.freeze(["lockID","dateGenerated","signedByName","signedByUsername","signedByRole","data","isBackup","isExport","isPartial","periodStart","periodEnd"])
export const SECTION_ORDER = Object.freeze(["claims","serviceentries","medicineentries","summaryitems","attachmentdata","attachments","comments","validations","validation_results","validation_zclaims","prescribersfordays","_meta","_dbstruct"])
export const APP_VERSION_ORDER = Object.freeze(["version","build","type","sha1","client","mode","cpuType"])
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
