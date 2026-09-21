// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { it } from 'vitest'

// Existing psql fixtures are designed for independent empty databases, not a
// deployed Supabase database. Expand only their two supported psql directives.
function fixtureSql(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).map((line) => {
    if (line.startsWith('\\set ON_ERROR_STOP')) return ''
    if (line.startsWith('\\ir ')) return fixtureSql(resolve(dirname(path), line.slice(4).trim()))
    if (line.startsWith('\\')) throw new Error('Unsupported fixture directive')
    return line
  }).join('\n')
}

for (const name of ['facility_connectivity_priority', 'internal_trigger_execution', 'nhis_ccc_transitions']) {
  it(`runs existing isolated database fixture: ${name}`, async () => {
    const db = new PGlite()
    try {
      await db.exec('create role anon; create role authenticated; create role service_role;')
      await db.exec(fixtureSql(resolve(`supabase/tests/${name}.sql`)))
    } finally { await db.close() }
  }, 60000)
}
