import { supabase } from '../lib/supabase'
export async function queueClaimExportAlert(recording) {
 const { error } = await supabase.rpc('complete_claim_export_alert', {
  p_claim_ids: recording.chunks.flatMap(chunk => chunk.claimIds), p_hash: recording.artifactSha256,
 })
 if (error) throw error
}
