// @vitest-environment node
import { it, expect, vi } from 'vitest'
vi.mock('../../local-branch-server/src/config.js', () => ({ config: { supabaseUrl:'https://example.invalid', supabaseSyncKey:'test-key', branchSyncToken:'test-branch-token' } }))
import { centralCcc } from '../../local-branch-server/src/cccGateway.js'

it('takes branch identity from the authenticated session, never the browser payload', async () => {
  const fetcher=vi.fn(async () => ({ok:true,json:async()=>({ccCode:'12345'})}))
  await centralCcc({actorId:'forged',activeRole:'super_admin',branchSyncToken:'forged',action:'save_ccc_policy'}, {userId:'staff',role:'pharmacist'}, undefined, fetcher)
  const body=JSON.parse(fetcher.mock.calls[0][1].body)
  expect(body).toMatchObject({actorId:'staff',activeRole:'pharmacist',branchSyncToken:'test-branch-token',action:'branch_ccc_generate'})
})
it('rejects missing authenticated actors before sending requests', async () => {
  const fetcher=vi.fn()
  await expect(centralCcc({},null,undefined,fetcher)).rejects.toThrow(/authenticated/)
  expect(fetcher).not.toHaveBeenCalled()
})
it('does not call an alternate provider or retry on connection failure', async () => {
  const fetcher=vi.fn(async () => {throw new Error('connection lost')})
  await expect(centralCcc({}, {userId:'staff',role:'pharmacist'},undefined,fetcher)).rejects.toThrow(/No alternate provider/)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
