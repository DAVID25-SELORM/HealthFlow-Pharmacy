// @vitest-environment node
import { it, expect, vi } from 'vitest'
import { resolveNehfamsCredentials } from '../../supabase/functions/_shared/nehfamsCredentials.ts'
it('reuses the saved pair only when no separate credentials exist', async () => {
 const loadSaved=vi.fn(async()=>({api_key_encrypted:'key',api_secret_encrypted:'secret'}))
 const decode=vi.fn(async value=>'decoded-'+value)
 expect(await resolveNehfamsCredentials({key:'',secret:'',configured:false,loadSaved,decode})).toEqual({key:'decoded-key',secret:'decoded-secret'})
 expect(decode).toHaveBeenCalledTimes(2)
})
it.each([{key:'',secret:'',configured:true},{key:'new',secret:'new-secret',configured:false},{key:'new',secret:'',configured:false}])('never mixes explicit or separately saved credentials with legacy values',async values=>{
 const loadSaved=vi.fn()
 expect(await resolveNehfamsCredentials({...values,loadSaved})).toEqual({key:values.key,secret:values.secret})
 expect(loadSaved).not.toHaveBeenCalled()
})
it('rejects a missing saved pair',async()=>{
 await expect(resolveNehfamsCredentials({key:'',secret:'',loadSaved:async()=>null})).rejects.toThrow(/Save this facility/)
})
