import { inflateSync } from 'node:zlib'
import { decimalUnits, accreditationIssues } from '../../src/claimit/compatibility.js'

// Parse PHP's byte-counted strings without decoding compressed attachments.
// Deliberately rejects executable object/reference forms and duplicate keys.
export function parsePhp(bytes) {
  const input = Buffer.from(bytes)
  let offset = 0
  const take = (expected) => {
    if (input.subarray(offset, offset + expected.length).toString() !== expected) throw new Error(`Invalid PHP delimiter at byte ${offset}`)
    offset += expected.length
  }
  const until = (delimiter) => {
    const end = input.indexOf(delimiter, offset)
    if (end < 0) throw new Error('Truncated PHP value')
    const value = input.subarray(offset, end).toString()
    offset = end + 1
    return value
  }
  const read = (depth = 0) => {
    if (depth > 100) throw new Error('PHP nesting limit exceeded')
    const type = String.fromCharCode(input[offset++])
    if (type === 'N') { take(';'); return null }
    take(':')
    if (type === 'b') {
      const value = until(';')
      if (!['0', '1'].includes(value)) throw new Error('Invalid PHP boolean')
      return value === '1'
    }
    if (type === 'i' || type === 'd') {
      const value = Number(until(';'))
      if (!Number.isFinite(value)) throw new Error('Invalid PHP number')
      return value
    }
    if (type === 's') {
      const length = Number(until(':'))
      if (!Number.isSafeInteger(length) || length < 0 || length > input.length - offset) throw new Error('Invalid PHP string length')
      take('"')
      const value = input.subarray(offset, offset + length)
      offset += length
      take('";')
      return value
    }
    if (type === 'a') {
      const length = Number(until(':'))
      if (!Number.isSafeInteger(length) || length < 0 || length > input.length) throw new Error('Invalid PHP array length')
      take('{')
      const value = new Map()
      for (let index = 0; index < length; index++) {
        const rawKey = read(depth + 1)
        const key = Buffer.isBuffer(rawKey) ? rawKey.toString('utf8') : rawKey
        if (typeof key !== 'string' && !Number.isInteger(key)) throw new Error('Invalid PHP key')
        if (value.has(key)) throw new Error('Duplicate PHP key')
        value.set(key, read(depth + 1))
      }
      take('}')
      return value
    }
    throw new Error(`Unsupported PHP type at byte ${offset - 2}`)
  }
  const value = read()
  if (offset !== input.length) throw new Error('Trailing PHP bytes')
  return value
}

export function readCxf(bytes) {
  const input = Buffer.from(bytes)
  if (!input.subarray(0, 3).equals(Buffer.from([1, 2, 25]))) throw new Error('Unrecognized CXF envelope')
  return parsePhp(inflateSync(input.subarray(3), { maxOutputLength: 256 * 1024 * 1024 }))
}

export const phpText = (value) => Buffer.isBuffer(value) ? value.toString('utf8') : value

// Only keys, PHP types, and row counts: safe to use with real patient files.
export function structuralContract(bundle) {
  const data = bundle.get('data')
  const fields = {}
  const counts = {}
  for (const [section, rows] of data) {
    if (!(rows instanceof Map)) continue
    counts[section] = rows.size
    const first = rows.values().next().value
    fields[section] = first instanceof Map ? [...first.keys()] : [...rows.keys()]
  }
  const meta = data.get('_meta')
  return {
    envelope: [1, 2, 25],
    topLevel: [...bundle.keys()],
    sections: [...data.keys()],
    fields,
    counts,
    metadata: [...meta.keys()],
    appVersion: [...meta.get('appVersion').keys()],
    accreditationFields: [...(meta.get('accreditations')?.values().next().value?.keys?.() || [])],
    schema: Object.fromEntries([...data.get('_dbstruct')].map(([section, columns]) => [section,
      Object.fromEntries([...columns].map(([key, type]) => [key, phpText(type)])),
    ])),
  }
}

const phpType = (value) => value === null ? 'null' : Buffer.isBuffer(value) ? (value.length ? 'string' : 'empty string')
  : value instanceof Map ? (value.size ? 'array' : 'empty array') : typeof value

export function auditCxf(bundle) {
  const data = bundle.get('data')
  const rows = (section) => [...(data.get(section)?.values() || [])]
  const claims = rows('claims')
  const types = {}
  for (const section of ['claims','medicineentries','serviceentries','summaryitems','attachments','attachmentdata','validations','prescribersfordays']) {
    const observed = {}
    for (const row of rows(section)) for (const [key,value] of row) {
      observed[key] ||= new Set()
      observed[key].add(phpType(value))
    }
    types[section] = Object.fromEntries(Object.entries(observed).map(([key,values]) => [key,[...values].sort()]))
  }
  const sums = (section, field) => {
    const result = new Map()
    for (const row of rows(section)) {
      const id = phpText(row.get('_claim_id'))
      result.set(id,(result.get(id) || 0n) + decimalUnits(phpText(row.get(field)),4))
    }
    return result
  }
  const medicines = sums('medicineentries','cost'), services = sums('serviceentries','cost'), summaries = sums('summaryitems','amount')
  const finances = { invalidMedicineTotals: 0, invalidServiceTotals: 0, invalidClaimTotals: 0, invalidSummaries: 0, invalidBatchTotal: 0 }
  let total = 0n
  for (const claim of claims) {
    const id=phpText(claim.get('guid'))
    const amount=(key) => decimalUnits(phpText(claim.get(key)),4)
    if ((medicines.get(id) || 0n)!==amount('medCost')) finances.invalidMedicineTotals++
    if ((services.get(id) || 0n)!==amount('procCost')) finances.invalidServiceTotals++
    if (amount('medCost')+amount('procCost')+amount('diagCost')+amount('inveCost')!==amount('totalCost')) finances.invalidClaimTotals++
    if ((summaries.get(id) || 0n)!==amount('totalCost')) finances.invalidSummaries++
    total+=amount('totalCost')
  }
  if (total!==decimalUnits(phpText(data.get('_meta').get('totalCost')),4)) finances.invalidBatchTotal++
  const meta = data.get('_meta')
  const rawAccred = meta.get('accreditations')
  const accreds = rawAccred?.has('dateGenerated') ? [rawAccred] : [...(rawAccred?.values() || [])].filter((v) => v instanceof Map)
  const dates = accreds.flatMap((a) => accreditationIssues({
    generated:phpText(a.get('dateGenerated')),expiry:phpText(a.get('expiryDate')),
    effective:phpText(a.get('effectiveDate') || a.get('accred_effectiveDate')),
    today:String(phpText(bundle.get('dateGenerated'))).slice(0,10),
  }))
  const claimIds = new Set(claims.map((c) => phpText(c.get('guid'))))
  const attachments = rows('attachments')
  const attachmentIds = new Set(attachments.map((a) => phpText(a.get('attach_id'))))
  return {
    scanned:claims.length,
    missingSigner:claims.filter((c) => ['signedOn','signedByname','signedByuserID','signedByrole'].some((key) => !phpText(c.get(key)))).length,
    finances, accreditationIssues:[...new Set(dates)],types,
    attachments: {
      records:attachments.length,
      orphanReferences:attachments.filter((a) => !claimIds.has(phpText(a.get('_claim_id')))).length,
      orphanData:rows('attachmentdata').filter((a) => !attachmentIds.has(phpText(a.get('_attach_id')))).length,
      missingData:attachments.filter((a) => !rows('attachmentdata').some((d) => phpText(d.get('_attach_id'))===phpText(a.get('attach_id')))).length,
    },
  }
}
