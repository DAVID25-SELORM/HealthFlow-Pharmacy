// @vitest-environment node
import { it, expect, vi } from 'vitest'
import { validateSavedNehfamsConnection } from '../../supabase/functions/_shared/nehfamsConnection.ts'
function setup(body={HPN:'123',HPName:'Test Facility',AuthMode:'1FA',OTACAuthEnabled:false}) {
 const filters=[];const chain={select:()=>chain,eq:(...args)=>{filters.push(args);return chain},maybeSingle:async()=>({data:{api_key_encrypted:'encrypted-key',api_secret_encrypted:'encrypted-secret',expected_hpn:'123',expected_name:'Test Facility',version:7}})}
 const db={from:vi.fn(()=>chain),rpc:vi.fn(async()=>({error:null}))}
 const fetcher=vi.fn(async()=>({ok:true,json:async()=>body}))
 return {filters,db,fetcher,options:{db,fetcher,org:'org-a',actor:'admin',environment:'test',decode:async x=>x}}
}
it('validates only the scoped saved environment and records version',async()=>{
 const {options,filters,db,fetcher}=setup();await validateSavedNehfamsConnection(options)
 expect(filters).toEqual([['organization_id','org-a'],['environment','test']])
 expect(fetcher.mock.calls[0][0]).toBe('https://elig.nhia.gov.gh:5007/api/hmis/auth/hpinfo')
 expect(fetcher.mock.calls[0][1].method).toBe('GET')
 expect(db.rpc).toHaveBeenCalledWith('validate_nehfams_connection',expect.objectContaining({p_version:7,p_environment:'test',p_org:'org-a'}))
})
it('never records a mismatched facility',async()=>{
 const {options,db}=setup({HPN:'other',HPName:'Other'});await expect(validateSavedNehfamsConnection(options)).rejects.toThrow(/identity/);expect(db.rpc).not.toHaveBeenCalled()
})
it('sanitizes authentication errors',async()=>{
 const {options,fetcher,db}=setup();fetcher.mockResolvedValue({ok:false,status:401})
 await expect(validateSavedNehfamsConnection(options)).rejects.toThrow(/NHIA rejected the saved API credentials/)
 expect(db.rpc).not.toHaveBeenCalled()
})
it('rejects stale validation persistence',async()=>{
 const {options,db}=setup();db.rpc.mockResolvedValue({error:{message:'private'}})
 await expect(validateSavedNehfamsConnection(options)).rejects.toThrow(/changed/)
})

it.each([
 [403, /rejected the saved API credentials/],
 [429, /HTTP 429/],
 [500, /HTTP 500/],
])('reports safe HTTP diagnostics without recording validation (%s)', async (status, message) => {
 const {options,fetcher,db}=setup()
 fetcher.mockResolvedValue({ok:false,status,json:async()=>({secret:'must-not-leak'})})
 await expect(validateSavedNehfamsConnection(options)).rejects.toThrow(message)
 expect(db.rpc).not.toHaveBeenCalled()
 expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each([
 [new DOMException('private upstream data','TimeoutError'), /timed out/],
 [new TypeError('private upstream data'), /Could not reach NHIA/],
])('sanitizes transport errors and does not retry', async (error, message) => {
 const {options,fetcher,db}=setup();fetcher.mockRejectedValue(error)
 await expect(validateSavedNehfamsConnection(options)).rejects.toThrow(message)
 expect(db.rpc).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(1)
})
it('rejects malformed JSON without recording validation',async()=>{
 const {options,fetcher,db}=setup()
 fetcher.mockResolvedValue({ok:true,json:async()=>{throw new Error('private body')}})
 await expect(validateSavedNehfamsConnection(options)).rejects.toThrow(/invalid JSON/)
 expect(db.rpc).not.toHaveBeenCalled()
})
