import { readCxfStream } from './lib/cxf-stream-reader.mjs'
import { profileCxf, contractFromProfile } from './lib/cxf-profile.mjs'

// Usage: node scripts/extract-cxf-contract.mjs file.cxf > contract.json
// Emits a sanitized structural contract: key orders, PHP types, version metadata and
// value SHAPES. No patient, provider, credential, date or signer values.
const path = process.argv[2]
if (!path) throw new Error('Usage: node scripts/extract-cxf-contract.mjs file.cxf')
const { bundle } = await readCxfStream(path)
console.log(JSON.stringify(contractFromProfile(profileCxf(bundle)), null, 2))
