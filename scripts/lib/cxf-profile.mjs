import { phpText, structuralContract, auditCxf } from './cxf-reader.mjs'

// Sanitized structural profile of a parsed CXF: keys, PHP types, counts, versions,
// dates and value-shape patterns. Never includes patient values, member numbers,
// credentials, claim ids or attachment content, so it is safe to print and to
// derive committed fixtures from.
const text = (value) => {
  const v = phpText(value)
  return v == null ? null : String(v)
}
const shape = (value) => {
  const v = text(value)
  return v == null ? 'null' : v.replace(/[0-9]+/g, 'N').replace(/[A-Za-z]+/g, (word) => (word === word.toUpperCase() ? 'U' : 'l'))
}
const tally = (values) => {
  const result = {}
  for (const value of values) result[value] = (result[value] || 0) + 1
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}
const mapEntries = (value) => (value instanceof Map ? [...value] : [])
const flatten = (value) => Object.fromEntries(mapEntries(value).map(([k, v]) => [k, v instanceof Map ? flatten(v) : text(v)]))

export function profileCxf(bundle, { label = '' } = {}) {
  const data = bundle.get('data')
  const meta = data.get('_meta')
  const rows = (section) => [...(data.get(section)?.values() || [])]
  const claims = rows('claims')
  const contract = structuralContract(bundle)
  const audit = auditCxf(bundle)
  const claimKeys = contract.fields.claims || []
  const accreditationRows = mapEntries(meta.get('accreditations')).map(([, row]) => row).filter((row) => row instanceof Map)
  const durationRows = rows('medicineentries')
  const totalCost = text(meta.get('totalCost'))
  return {
    label,
    envelope: { header: contract.envelope, topLevel: contract.topLevel,
      flags: Object.fromEntries(['isBackup', 'isExport', 'isPartial'].map((key) => [key, bundle.get(key)])),
      lockIdShape: shape(bundle.get('lockID')), dateGeneratedShape: shape(bundle.get('dateGenerated')),
      periodStart: text(bundle.get('periodStart')), periodEnd: text(bundle.get('periodEnd')) },
    sections: contract.sections,
    counts: contract.counts,
    claimKeyOrder: claimKeys,
    claimTypePosition: claimKeys.indexOf('claimType'),
    fieldOrder: contract.fields,
    claimStatuses: tally(claims.map((claim) => text(claim.get('status')))),
    claimTypes: tally(claims.map((claim) => text(claim.get('claimType')))),
    signers: {
      claims: claims.length,
      missingAll: claims.filter((claim) => ['signedOn', 'signedByname', 'signedByuserID', 'signedByrole'].every((key) => !text(claim.get(key)))).length,
      missingAny: audit.missingSigner,
    },
    metaKeys: contract.metadata,
    providerLevel: text(meta.get('providerLevel')),
    versions: {
      policies: flatten(meta.get('policies')), medVersions: flatten(meta.get('medVersions')), servVersions: flatten(meta.get('servVersions')),
      claimServVersion: tally(claims.map((claim) => text(claim.get('servVersion')))),
      claimMedVersion: tally(claims.map((claim) => text(claim.get('medVersion')))),
      claimPolicyVersion: tally(claims.map((claim) => text(claim.get('policyVersion')))),
    },
    appVersion: flatten(meta.get('appVersion')),
    cpuTypePresent: meta.get('appVersion')?.has?.('cpuType') || false,
    accreditation: {
      keys: contract.accreditationFields,
      rows: accreditationRows.map((row) => ({
        dateGenerated: text(row.get('dateGenerated')), expiryDate: text(row.get('expiryDate')),
        effectiveDate: text(row.get('effectiveDate') ?? row.get('accred_effectiveDate')),
      })),
      claimEffectiveDates: tally(claims.map((claim) => text(claim.get('accred_effectiveDate')))),
      issues: audit.accreditationIssues,
    },
    credUsage: { rows: mapEntries(meta.get('credUsage')).length, keys: [...(mapEntries(meta.get('credUsage'))[0]?.[1]?.keys?.() || [])] },
    dbstructSections: Object.keys(contract.schema),
    schema: contract.schema,
    validationSections: {
      validations: rows('validations').length, validationZclaims: rows('validation_zclaims').length,
      validationResults: rows('validation_results').length, prescribersfordays: rows('prescribersfordays').length,
    },
    durations: {
      value: tally(durationRows.map((row) => shape(row.get('duration_value')))),
      unit: tally(durationRows.map((row) => text(row.get('duration_unit')))),
      desc: tally(durationRows.map((row) => shape(row.get('duration_desc')))),
    },
    summaries: { rows: rows('summaryitems').length, perClaim: rows('summaryitems').length === claims.length },
    attachments: audit.attachments,
    finances: audit.finances,
    batchTotal: { value: totalCost, decimals: (totalCost?.split('.')[1] || '').length, hasBinaryDrift: (totalCost?.split('.')[1] || '').length > 2 },
    types: audit.types,
  }
}

// Sanitized, committable projection of a profile: key orders, PHP types and value
// SHAPES only (no dates, names, credentials or claim data).
export const contractFromProfile = (p) => ({
  envelope: p.envelope.header,
  topLevel: p.envelope.topLevel,
  envelopeFlags: p.envelope.flags,
  sections: p.sections,
  fields: p.fieldOrder,
  metadata: p.metaKeys,
  appVersion: p.appVersion,
  schema: p.schema,
  versions: {
    providerLevel: p.providerLevel,
    policies: p.versions.policies,
    medVersions: p.versions.medVersions,
    servVersions: p.versions.servVersions,
  },
  accreditationFields: p.accreditation.keys,
  credUsageFields: p.credUsage.keys,
  claimTypes: Object.keys(p.claimTypes),
  claimStatuses: Object.keys(p.claimStatuses),
  durationShape: { value: Object.keys(p.durations.value), unit: Object.keys(p.durations.unit), desc: Object.keys(p.durations.desc) },
  validationSectionsPopulated: p.validationSections.validations > 0,
  claimFieldTypes: p.types.claims,
})
