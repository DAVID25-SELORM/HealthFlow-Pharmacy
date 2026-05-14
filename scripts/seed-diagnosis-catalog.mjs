import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { DIAGNOSIS_CATALOG } from '../src/data/diagnosisCatalog.js'

const BATCH_SIZE = 1000

const readEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return

  const content = fs.readFileSync(filePath, 'utf8')
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) return

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')

    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  })
}

readEnvFile(path.resolve('.env.local'))
readEnvFile(path.resolve('.env'))

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Set SUPABASE_URL or VITE_SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY, before seeding.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
})

const rows = DIAGNOSIS_CATALOG.map((diagnosis) => ({
  source: diagnosis.source,
  code: diagnosis.code,
  label: diagnosis.label,
  source_version: diagnosis.source === 'Ghana STG 2017'
    ? 'GHANA-STG-2017-1'
    : 'ICD-10-CSV-master',
  is_active: true,
}))

let imported = 0

for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
  const batch = rows.slice(offset, offset + BATCH_SIZE)
  const { error } = await supabase
    .from('diagnosis_catalog')
    .upsert(batch, {
      onConflict: 'source,code,label',
      ignoreDuplicates: false,
    })

  if (error) {
    console.error(`Failed at row ${offset + 1}: ${error.message}`)
    process.exit(1)
  }

  imported += batch.length
  console.log(`Seeded ${imported}/${rows.length} diagnoses`)
}

console.log(`Diagnosis catalog seed complete: ${imported} rows upserted.`)
