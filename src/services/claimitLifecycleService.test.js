import { beforeEach, expect, it, vi } from 'vitest'
import { supabase } from '../lib/supabase'
import { getSignedExportClaims, signNhisClaim, auditClaimItClaims, recordCxfExport } from './claimitLifecycleService'

vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
beforeEach(() => vi.resetAllMocks())

it('fetches authoritative data and never sends browser signer identity to the server', async () => {
  supabase.rpc.mockResolvedValue({data:[{id:'claim',signed_by_name:'Authenticated signer'}],error:null})
  const result=await getSignedExportClaims([{id:'claim',signed_by_name:'Forged name',total_amount:0}])
  expect(supabase.rpc).toHaveBeenCalledWith('claimit_export_claims',{p_claim_ids:['claim'],p_reexport_reason:null})
  expect(result[0].signed_by_name).toBe('Authenticated signer')
  supabase.rpc.mockResolvedValue({data:{id:'signature'},error:null})
  await signNhisClaim('claim','Reviewed')
  expect(supabase.rpc).toHaveBeenLastCalledWith('sign_nhis_claim',{p_claim_id:'claim',p_reason:'Reviewed'})
})

it('fails closed on server errors and incomplete responses', async () => {
  supabase.rpc.mockResolvedValue({data:null,error:new Error('MISSING_OR_STALE_SIGNER')})
  await expect(getSignedExportClaims([{id:'claim'}])).rejects.toThrow('MISSING_OR_STALE_SIGNER')
  supabase.rpc.mockResolvedValue({data:[],error:null})
  await expect(getSignedExportClaims([{id:'claim'}])).rejects.toThrow('Incomplete server')
})

it('defaults to dry-run and batches large export checks', async () => {
  supabase.rpc.mockResolvedValue({data:{scanned:0},error:null})
  await auditClaimItClaims()
  expect(supabase.rpc.mock.calls[0][1].p_apply).toBe(false)
  supabase.rpc.mockImplementation(async (_name,args) => ({data:args.p_claim_ids.map((id) => ({id})),error:null}))
  const candidates=Array.from({length:501},(_,i) => ({id:String(i)}))
  expect(await getSignedExportClaims(candidates)).toHaveLength(501)
  expect(supabase.rpc.mock.calls.slice(1).map((call) => call[1].p_claim_ids.length)).toEqual([500,1])
})

it('records the artifact hash and expected fingerprints before releasing a download', async () => {
  const { webcrypto } = await import('node:crypto')
  vi.stubGlobal('crypto',webcrypto)
  try {
    supabase.rpc.mockResolvedValue({data:null,error:null})
    await recordCxfExport([{id:'claim',claimit_fingerprint:'snapshot'}],new Uint8Array([1,2,3]),'Corrected metadata')
    expect(supabase.rpc).toHaveBeenCalledWith('record_nhis_cxf_export_atomic',expect.objectContaining({
      p_claim_ids:['claim'],p_fingerprints:{claim:'snapshot'},p_reexport_reason:'Corrected metadata',
      p_artifact_sha256:expect.stringMatching(/^[0-9a-f]{64}$/),
    }))
  } finally { vi.unstubAllGlobals() }
})

it('commits a large artifact with one RPC and propagates failure', async () => {
  const { webcrypto } = await import('node:crypto')
  vi.stubGlobal('crypto',webcrypto)
  try {
    const claims=Array.from({length:501},(_,i)=>({id:String(i),claimit_fingerprint:`revision-${i}`}))
    supabase.rpc.mockResolvedValue({data:null,error:new Error('Last batch rejected')})
    await expect(recordCxfExport(claims,new Uint8Array([1,2,3]))).rejects.toThrow('Last batch rejected')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc.mock.calls[0][1].p_claim_ids).toHaveLength(501)
  } finally { vi.unstubAllGlobals() }
})

it('rejects duplicate, empty, and excessive batches before fetching data', async () => {
  await expect(getSignedExportClaims([])).rejects.toThrow('between 1 and 10000')
  await expect(getSignedExportClaims([{id:'same'},{id:'same'}])).rejects.toThrow('Duplicate')
  await expect(getSignedExportClaims(Array.from({length:10001},(_,i)=>({id:String(i)})))).rejects.toThrow('between 1 and 10000')
  expect(supabase.rpc).not.toHaveBeenCalled()
})
