import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import GeneralSearch from './GeneralSearch'
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ role: 'claims_officer', user: { id: 'user' } }) }))
vi.mock('../context/TenantContext', () => ({ useTenant: () => ({ organization: { id: 'org' }, canUseNhis: true }) }))
vi.mock('../lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ abortSignal: () => Promise.resolve({ data: [{ id: 'branch', name: 'Main branch' }] }) }) }) }) } }))
vi.mock('../services/generalSearchService', () => {
  const sources = [{ key: 'nhis', label: 'NHIS claims', fields: ['claim_number', 'ccc_no'], extra: ['branch_id', 'status', 'service_date_from'], title: 'claim_number' }]
  return { searchSources: sources, allowedSearchSources: () => sources, searchFacilityRecords: async () => [{ ...sources[0], rows: [{ id: 'claim1', claim_number: 'NHIS-002932', ccc_no: '28058', branch_id: 'branch', status: 'served', service_date_from: '2026-07-20' }] }] }
})
it('shows a historical CCC result with an exact claim link and branch', async () => {
  render(<MemoryRouter initialEntries={['/search?search=28058']}><GeneralSearch /></MemoryRouter>)
  expect(await screen.findByText('NHIS-002932')).toBeInTheDocument()
  expect(screen.getByText('28058')).toBeInTheDocument()
  expect(screen.getByText('Main branch')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Open claim' })).toHaveAttribute('href', '/nhis?claimId=claim1')
})
