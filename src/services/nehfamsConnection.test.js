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
 const {options,fetcher,db}=setup();fetcher.mockResolvedValue({ok:false})
 await expect(validateSavedNehfamsConnection(options)).rejects.toThrow('NeHFAMS connection validation failed. Check credentials and connectivity.')
 expect(db.rpc).not.toHaveBeenCalled()
})
it('rejects stale validation persistence',async()=>{
 const {options,db}=setup();db.rpc.mockResolvedValue({error:{message:'private'}})
 await expect(validateSavedNehfamsConnection(options)).rejects.toThrow(/changed/)
})
