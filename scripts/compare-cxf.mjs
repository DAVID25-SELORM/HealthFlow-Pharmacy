import { readFileSync, statSync } from 'node:fs'
import { readCxf, structuralContract, phpText, auditCxf } from './lib/cxf-reader.mjs'
import { readCxfStream } from './lib/cxf-stream-reader.mjs'

// Files above the in-memory reader's 256 MB inflate limit are streamed.
const IN_MEMORY_LIMIT = 32 * 1024 * 1024
const load = async (path) => statSync(path).size > IN_MEMORY_LIMIT ? (await readCxfStream(path)).bundle : readCxf(readFileSync(path))

const paths = process.argv.slice(2)
if (!paths.length || paths.length > 2) throw new Error('Usage: node scripts/compare-cxf.mjs reference.cxf [generated.cxf]')
const contracts = await Promise.all(paths.map(async (path) => {
  const bundle = await load(path)
  const contract = structuralContract(bundle)
  const meta = bundle.get('data').get('_meta')
  contract.versions = Object.fromEntries(['providerLevel', 'policies', 'medVersions', 'servVersions', 'appVersion'].map((key) => [
    key, meta.get(key) instanceof Map ? [...meta.get(key)].map(([k, v]) => [k, phpText(v)]) : phpText(meta.get(key)),
  ]))
  const claims = [...bundle.get('data').get('claims').values()]
  contract.lifecycle = { claims: claims.length, missingSigner: claims.filter((claim) =>
    ['signedOn', 'signedByname', 'signedByuserID', 'signedByrole'].some((key) => !phpText(claim.get(key)))).length }
  contract.audit = auditCxf(bundle)
  return contract
}))
if (contracts.length === 1) console.log(JSON.stringify(contracts[0], null, 2))
else {
  const [reference, generated] = contracts
  const compare = (category, a, b) => ({ category, status: JSON.stringify(a) === JSON.stringify(b) ? 'PASS' : 'DIFFERENCE', reference: a, generated: b })
  console.log(JSON.stringify([
    compare('container', reference.envelope, generated.envelope),
    compare('top-level sections', reference.sections, generated.sections),
    ...Object.keys(reference.fields).map((key) => compare(`field order: ${key}`, reference.fields[key], generated.fields[key])),
    compare('metadata', reference.metadata, generated.metadata),
    compare('versions', reference.versions, generated.versions),
    compare('schema', reference.schema, generated.schema),
    compare('data types and nullability', reference.audit.types, generated.audit.types),
    { category: 'financial reconciliation', reference: reference.audit.finances, generated: generated.audit.finances },
    { category: 'accreditation semantics', reference: reference.audit.accreditationIssues, generated: generated.audit.accreditationIssues },
    { category: 'attachments', reference: reference.audit.attachments, generated: generated.audit.attachments },
    { category: 'claim lifecycle', reference: reference.lifecycle, generated: generated.lifecycle },
  ], null, 2))
}
