import { config } from './config.js'

// Called only after the local server authenticates its user session. Never accept actor identity from a request body.
export async function centralCcc(payload, actor, action = 'branch_ccc_generate', fetcher = fetch) {
  if (!actor?.userId || !config.supabaseUrl || !config.supabaseSyncKey || !config.branchSyncToken) {
    throw new Error('CCC requires an authenticated branch session and a configured cloud connection.')
  }
  let response
  try {
    response = await fetcher(`${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/tier-access`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', apikey: config.supabaseSyncKey, Authorization: `Bearer ${config.supabaseSyncKey}` },
      body: JSON.stringify({ ...payload, action, branchSyncToken: config.branchSyncToken, actorId: actor.userId, activeRole: actor.role }),
    })
  } catch { throw new Error('Cloud CCC service could not be reached. Check attendance status before retrying. No alternate provider was used.') }
  const result = await response.json()
  if (!response.ok || result.error) throw new Error(result.error || 'Cloud CCC request failed.')
  return result
}
