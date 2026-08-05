import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const manifestUrl = new URL('../config/production-baseline.json', import.meta.url)
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
const failures = []

for (const [file, expected] of Object.entries(manifest.criticalFiles)) {
  const bytes = await readFile(new URL(`../${file}`, import.meta.url))
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) failures.push(`${file}: expected ${expected}, received ${actual}`)
}

if (failures.length) {
  console.error('Critical production files changed without updating the protected baseline:')
  failures.forEach((failure) => console.error(`- ${failure}`))
  console.error('Update characterization tests, the impact report, and the manifest in the same reviewed change.')
  process.exit(1)
}

console.log(`Protected production baseline verified: ${manifest.baselineId}`)
