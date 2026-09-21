import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { readCxfStream } from './lib/cxf-stream-reader.mjs'
import { profileCxf } from './lib/cxf-profile.mjs'

// Usage: node scripts/profile-cxf.mjs file.cxf [more.cxf ...]
// Prints sanitized structural profiles (no patient values). Streams, so it is safe
// for full-month files that exceed the in-memory reader's 256 MB limit.
const paths = process.argv.slice(2)
if (!paths.length) throw new Error('Usage: node scripts/profile-cxf.mjs file.cxf [more.cxf ...]')
const profiles = []
for (const path of paths) {
  const { bundle, decompressedBytes } = await readCxfStream(path)
  profiles.push({ ...profileCxf(bundle, { label: basename(path).replace(/\[[^\]]*\]/, '[provider]') }), fileBytes: statSync(path).size, decompressedBytes })
}
console.log(JSON.stringify(profiles.length === 1 ? profiles[0] : profiles, null, 2))
