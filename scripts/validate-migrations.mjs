import { readdir, readFile } from 'node:fs/promises'
import process from 'node:process'

const migrationsUrl = new URL('../supabase/migrations/', import.meta.url)
const files = (await readdir(migrationsUrl)).filter((name) => name.endsWith('.sql')).sort()
const timestamps = new Map()
const failures = []

for (const file of files) {
  const match = file.match(/^(\d{14})_[a-z0-9_]+\.sql$/)
  if (!match) {
    failures.push(`${file}: migration filename must start with a unique 14-digit timestamp`)
    continue
  }
  if (timestamps.has(match[1])) failures.push(`${file}: duplicate timestamp also used by ${timestamps.get(match[1])}`)
  timestamps.set(match[1], file)

  const sql = await readFile(new URL(file, migrationsUrl), 'utf8')
  if (/\bsecurity\s+definer\b/i.test(sql) && !/\bset\s+search_path\s*=/i.test(sql)) {
    failures.push(`${file}: SECURITY DEFINER function must set an explicit search_path`)
  }
}

if (failures.length) {
  console.error('Migration protection checks failed:')
  failures.forEach((failure) => console.error(`- ${failure}`))
  process.exit(1)
}

console.log(`Migration protection checks passed for ${files.length} migrations.`)
