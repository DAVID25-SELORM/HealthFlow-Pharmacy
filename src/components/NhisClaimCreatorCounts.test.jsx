import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NhisClaimCreatorCounts from './NhisClaimCreatorCounts'
const mocks = vi.hoisted(()=>({rpc:vi.fn(),local:vi.fn(()=>false)}))
vi.mock('../lib/supabase',()=>({supabase:{rpc:mocks.rpc}}))
vi.mock('../services/branchServerApi',()=>({shouldUseBranchServer:mocks.local}))
beforeEach(()=>{vi.clearAllMocks();mocks.local.mockReturnValue(false)})
describe('claim creator counts',()=>{
  it('shows server-wide creator counts instead of current page totals',async()=>{
    mocks.rpc.mockResolvedValue({data:[{creator_id:'a',creator_name:'Staff A',claim_count:1101},{creator_id:'b',creator_name:'Staff B',claim_count:3}],error:null})
    render(<NhisClaimCreatorCounts />)
    fireEvent.click(screen.getByText('Claims created by staff'))
    fireEvent.change(screen.getByLabelText('Created from'),{target:{value:'2026-09-01'}})
    fireEvent.change(screen.getByLabelText('Created through'),{target:{value:'2026-09-09'}})
    fireEvent.click(screen.getByRole('button',{name:'Show counts'}))
    await waitFor(()=>expect(screen.getByText(/1104 claims/)).toBeInTheDocument())
    expect(mocks.rpc).toHaveBeenCalledWith('get_nhis_claim_creator_counts',{p_from_date:'2026-09-01',p_to_date:'2026-09-09'})
    expect(screen.getByText('Staff A')).toBeInTheDocument()
  })
  it('shows a load failure rather than a zero count',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:new Error('failed')})
    render(<NhisClaimCreatorCounts />)
    fireEvent.click(screen.getByText('Claims created by staff'))
    fireEvent.click(screen.getByRole('button',{name:'Show counts'}))
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Unable to load'))
    expect(screen.queryByText(/0 claims/)).not.toBeInTheDocument()
  })
  it('does not present local-only counts as organizational totals',()=>{
    mocks.local.mockReturnValue(true)
    render(<NhisClaimCreatorCounts />)
    fireEvent.click(screen.getByText('Claims created by staff'))
    fireEvent.click(screen.getByRole('button',{name:'Show counts'}))
    expect(screen.getByRole('alert')).toHaveTextContent('Connect to the cloud')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
