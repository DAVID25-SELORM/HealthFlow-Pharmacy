import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { assertTarget, collectAudit, applyPreview } from './lib/claimit-rollout.mjs'

const [mode, projectRef, reportPath] = process.argv.slice(2)
if (!['audit', 'apply-staging'].includes(mode) || !reportPath || process.argv.length !== 5) {
  throw new Error('Usage: node scripts/claimit-rollout.mjs audit|apply-staging PROJECT_REF PRIVATE_REPORT_PATH')
}
const url = process.env.CLAIMIT_SUPABASE_URL
const key = process.env.CLAIMIT_PUBLISHABLE_KEY
const token = process.env.CLAIMIT_USER_ACCESS_TOKEN
assertTarget(url, projectRef, mode === 'apply-staging')
if (!key || !token) throw new Error('Set CLAIMIT_PUBLISHABLE_KEY and CLAIMIT_USER_ACCESS_TOKEN privately. Never use a service-role key.')
const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
})
const { data: identity, error: authError } = await client.auth.getUser(token)
if (authError || !identity?.user?.id) throw new Error('A valid authenticated project user session is required.')
const rpc = async (name, args) => {
  const { data, error } = await client.rpc(name, args)
  // Server errors may contain clinical values: do not echo the response body.
  if (error) throw new Error(`${name} failed (${error.code || 'request error'}). No further operations attempted.`)
  return data
}
const reportFile = resolve(reportPath)
const current = await collectAudit(rpc)
if (mode === 'audit') {
  mkdirSync(dirname(reportFile), { recursive: true })
  writeFileSync(reportFile, JSON.stringify({ projectRef, actorId: identity.user.id,
    generatedAt: new Date().toISOString(), ...current }, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ scope: 'authenticated actor organization only', ...current.counts }))
} else {
  const preview = JSON.parse(readFileSync(reportFile, 'utf8'))
  if (preview.projectRef !== projectRef || preview.actorId !== identity.user.id) throw new Error('Preview target/actor mismatch.')
  const age = Date.now() - Date.parse(preview.generatedAt)
  if (!Number.isFinite(age) || age < 0 || age > 3600000) throw new Error('Preview must be less than one hour old.')
  const applied = await applyPreview(rpc, preview, current)
  const after = await collectAudit(rpc)
  // Persist manual-review flags only after repairs; never sign or guess values.
  let cursor = null
  do {
    const page = await rpc('audit_nhis_claimit', { p_after: cursor, p_limit: 100, p_apply: true })
    if (page.errors !== 0) throw new Error('Flagging failed; stop and inspect.')
    if (page.scanned < 100) break
    if (!page.next_cursor || page.next_cursor === cursor) throw new Error('Flagging cursor did not advance.')
    cursor = page.next_cursor
  } while (cursor)
  writeFileSync(`${reportFile}.after.json`, JSON.stringify({ projectRef, actorId: identity.user.id,
    generatedAt: new Date().toISOString(), applied, ...after }, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ applied, reconciliation: after.counts }))
}
