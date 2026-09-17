import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../lib/supabase', () => ({ supabase: { rpc:vi.fn(), from:vi.fn() } }))
vi.mock('./branchServerApi', () => ({ listBranchRecords:vi.fn(), shouldUseBranchServer:vi.fn(() => false) }))
import { supabase } from '../lib/supabase'
import { listBranchRecords, shouldUseBranchServer } from './branchServerApi'
import { searchPrescribingDirectory, savePrescribingDirectoryEntry } from './prescribingDirectoryService'
beforeEach(()=>{ vi.clearAllMocks(); shouldUseBranchServer.mockReturnValue(false) })
it('requests bounded alias search without tenant impersonation or directory writes',async()=>{
 supabase.rpc.mockResolvedValue({data:[{id:'ridge'}],error:null})
 expect(await searchPrescribingDirectory({search:' Ridge '})).toEqual([{id:'ridge'}])
 expect(supabase.rpc).toHaveBeenCalledWith('search_prescribing_directory',{p_search:'Ridge',p_nhis_only:false,p_include_inactive:false,p_limit:30,p_offset:0})
 expect(supabase.from).not.toHaveBeenCalled()
})
it('uses the bounded cached directory on a branch',async()=>{
 shouldUseBranchServer.mockReturnValue(true)
 listBranchRecords.mockResolvedValue([{id:'cached'}])
 expect(await searchPrescribingDirectory({search:'UGMC',nhisOnly:true})).toEqual([{id:'cached'}])
 expect(listBranchRecords).toHaveBeenCalledWith('nhis/prescribing-facilities',{directory:'true',searchTerm:'UGMC',nhisOnly:'true',limit:30})
 expect(supabase.rpc).not.toHaveBeenCalled()
})
it('saves only reference data and keeps unknown eligibility null',async()=>{
 const q={insert:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data:{id:'new'},error:null})}
 q.insert.mockReturnValue(q);q.select.mockReturnValue(q);supabase.from.mockReturnValue(q)
 await savePrescribingDirectoryEntry({facility_name:' New Hospital ',aliases:[' Alias ','Alias',''],organization_id:'forged',provider_number:'fabricated'})
 expect(supabase.from).toHaveBeenCalledWith('nhis_prescribing_facilities')
 expect(q.insert.mock.calls[0][0]).toMatchObject({facility_name:'New Hospital',aliases:['Alias'],is_shared:true,organization_id:null,branch_id:null,nhis_enabled:null})
 expect(q.insert.mock.calls[0][0]).not.toHaveProperty('provider_number')
})

it('keeps admin pagination on the authoritative directory even on a branch',async()=>{
 shouldUseBranchServer.mockReturnValue(true)
 supabase.rpc.mockResolvedValue({data:[],error:null})
 await searchPrescribingDirectory({administration:true,offset:30})
 expect(listBranchRecords).not.toHaveBeenCalled()
 expect(supabase.rpc).toHaveBeenCalledWith('search_prescribing_directory',expect.objectContaining({p_offset:30,p_limit:30}))
})
