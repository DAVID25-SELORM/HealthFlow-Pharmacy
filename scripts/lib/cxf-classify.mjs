// Classifies differences between a candidate CXF contract and the proven baselines
// instead of demanding byte/field parity with the May Claim-IT file.
//
//   may     = genuine Claim-IT export: structural reference only
//   june    = successful West Point HealthFlow June export accepted by Claim-IT: the
//             proven compatibility baseline
//   current = contract projected from the exporter output under test
//
// Inputs are sanitized contracts (see contractFromProfile); no patient data.
export const CATEGORY = Object.freeze({
  REQUIRED: 'REQUIRED COMPATIBILITY',
  ACCEPTED: 'HEALTHFLOW-ACCEPTED VARIATION',
  FACILITY: 'FACILITY-SPECIFIC DATA',
  SUSPICIOUS: 'SUSPICIOUS DATA',
  REGRESSION: 'ACTUAL REGRESSION',
})

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// Whether a text field is empty is claim data, not a type difference.
const stringish = (type) => (type === 'empty string' ? 'string' : type)
const SIGNER_FIELDS = ['signedOn', 'signedByname', 'signedByuserID', 'signedByrole']

// Structural properties that must equal the accepted June output.
const REQUIRED_CHECKS = [
  ['CXF envelope header', (c) => c.envelope],
  ['top-level structure', (c) => c.topLevel],
  ['envelope flags', (c) => c.envelopeFlags],
  ['section list and order', (c) => c.sections],
  ['claim field names and order (incl. claimType position)', (c) => c.fields?.claims],
  ['medicine entry fields', (c) => c.fields?.medicineentries],
  ['service entry fields', (c) => c.fields?.serviceentries],
  ['summary item fields', (c) => c.fields?.summaryitems],
  ['attachment fields', (c) => c.fields?.attachments],
  ['attachment data fields', (c) => c.fields?.attachmentdata],
  ['metadata keys and order', (c) => c.metadata],
  ['_dbstruct schema (tables, columns, order, types)', (c) => c.schema],
  ['appVersion keys and values (cpuType absence)', (c) => c.appVersion],
  ['policy version representation', (c) => c.versions?.policies],
  ['medicine version representation', (c) => c.versions?.medVersions],
  ['accreditation structure', (c) => c.accreditationFields],
  ['credUsage structure', (c) => c.credUsageFields],
  ['claim type values', (c) => c.claimTypes],
  ['claim status values', (c) => c.claimStatuses],
  ['medicine duration representation', (c) => c.durationShape],
  ['validation sections populated', (c) => c.validationSectionsPopulated],
]

// Data-dependent: differs by facility/claim mix, not by exporter behavior.
const FACILITY_CHECKS = [['provider level code', (c) => c.versions?.providerLevel]]

export function classifyContracts({ may, june, current, accreditationIssues = [] }) {
  const results = []
  const add = (category, check, detail = '') => results.push({ category, check, detail })
  const isRegression = () => results.some((entry) => entry.category === CATEGORY.REGRESSION)

  for (const [name, get] of REQUIRED_CHECKS) {
    const [m, j, c] = [get(may || {}), get(june), get(current)]
    if (!same(j, c)) add(CATEGORY.REGRESSION, name, 'differs from the accepted West Point June output')
    else if (m !== undefined && !same(m, j)) add(CATEGORY.ACCEPTED, name, 'differs from May but identical to accepted June output')
    else add(CATEGORY.REQUIRED, name, 'identical to accepted June output')
  }

  for (const [name, get] of FACILITY_CHECKS) {
    if (!same(get(june), get(current))) add(CATEGORY.FACILITY, name, 'provider-specific; not an exporter difference')
  }

  // servVersion is checked with the other claim field types below, but its pharmacy
  // representation is called out explicitly: June populated it, May had null.
  const juneTypes = june.claimFieldTypes || {}
  const currentTypes = current.claimFieldTypes || {}
  const mayTypes = may?.claimFieldTypes || {}
  for (const field of june.fields.claims) {
    const j = juneTypes[field] || [], c = currentTypes[field] || [], m = mayTypes[field]
    if (same(j, c)) {
      if (m !== undefined && !same(m, j)) add(CATEGORY.ACCEPTED, `claim.${field} type`, `${JSON.stringify(m)} in May, ${JSON.stringify(j)} in accepted June output`)
      continue
    }
    if (SIGNER_FIELDS.includes(field) && c.length && c.every((type) => ['null', 'string'].includes(type))) {
      add(CATEGORY.ACCEPTED, `claim.${field} type`, 'genuine stored signing evidence preserved, alone or mixed with legacy unsigned claims (June had none; not required)')
    } else if (c.length && c.map(stringish).every((type) => j.map(stringish).includes(type))) {
      add(CATEGORY.FACILITY, `claim.${field} type`, 'data-dependent subset of the June value types')
    } else {
      add(CATEGORY.REGRESSION, `claim.${field} type`, `${JSON.stringify(j)} accepted, ${JSON.stringify(c)} produced`)
    }
  }

  for (const issue of accreditationIssues) add(CATEGORY.SUSPICIOUS, issue, 'stored accreditation metadata needs review; never silently repaired')

  return { results, regressions: results.filter((entry) => entry.category === CATEGORY.REGRESSION), hasRegression: isRegression() }
}
