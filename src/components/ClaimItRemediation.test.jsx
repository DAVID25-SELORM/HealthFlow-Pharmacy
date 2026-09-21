import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import ClaimItRemediation from './ClaimItRemediation'
import { auditClaimItClaims, signNhisClaim } from '../services/claimitLifecycleService'
vi.mock('../services/claimitLifecycleService',()=>({auditClaimItClaims:vi.fn(),signNhisClaim:vi.fn(),repairClaimItTotal:vi.fn()}))
beforeEach(()=>{
  vi.resetAllMocks()
  auditClaimItClaims.mockResolvedValue({scanned:1,unchanged:0,manual_review_required:1,automatically_repaired:0,errors:0,
    would_warn:1,counts:{},warning_counts:{LEGACY_UNSIGNED_CLAIM:1},rows:[{id:'claim',claimNumber:'TEST-1',status:'served',issues:[],warnings:['LEGACY_UNSIGNED_CLAIM']}],next_cursor:'claim'})
})
it('previews before flagging and requires a review reason before signing',async()=>{
  render(<ClaimItRemediation />)
  expect(auditClaimItClaims).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Claim-IT signing and legacy review'))
  fireEvent.click(screen.getByText('Preview audit (100 claims)'))
  await screen.findByText('TEST-1')
  expect(auditClaimItClaims).toHaveBeenCalledWith(expect.objectContaining({apply:false}))
  // Legacy unsigned claims are a warning, and the panel says signing is optional for export.
  expect(screen.getByText(/Signing is optional and is not required to export/)).toBeInTheDocument()
  expect(screen.getAllByText('LEGACY_UNSIGNED_CLAIM').length).toBeGreaterThan(0)
  expect(screen.getByText(/Warnings \(never block export\): 1/)).toBeInTheDocument()
  expect(screen.getByText('Sign reviewed claim')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Reason for signing after review'),{target:{value:'Checked prescription'}})
  fireEvent.click(screen.getByText('Sign reviewed claim'))
  await waitFor(()=>expect(signNhisClaim).toHaveBeenCalledWith('claim','Checked prescription'))
})
it('shows server denial without reporting a successful repair',async()=>{
  auditClaimItClaims.mockRejectedValue(new Error('Claim signing/export access denied.'))
  render(<ClaimItRemediation />)
  fireEvent.click(screen.getByText('Claim-IT signing and legacy review'))
  fireEvent.click(screen.getByText('Preview audit (100 claims)'))
  expect(await screen.findByRole('alert')).toHaveTextContent('access denied')
})
