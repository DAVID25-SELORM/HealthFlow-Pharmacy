import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it } from 'vitest'
import NhisCccDuplicateReview from './NhisCccDuplicateReview'
it('shows review context with a masked member and a working existing-claim search link', () => {
  render(<MemoryRouter><NhisCccDuplicateReview signals={[{
    reasonCode: 'strong_duplicate', message: 'Same member, CCC and service date.',
    claim: { id: 'c1', claimNumber: 'NHIS-000123', memberNo: '12345678', serviceDate: '2026-10-01', status: 'served', totalAmount: 12, ccc: '12345', medicines: ['PARA500'] },
  }]} /></MemoryRouter>)
  expect(screen.getByText('****5678')).toBeInTheDocument()
  expect(screen.queryByText('12345678')).not.toBeInTheDocument()
  for (const text of ['NHIS-000123', '2026-10-01', 'served', '12.00', '12345', 'PARA500']) expect(screen.getByText(text)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Find existing claim (new tab)' })).toHaveAttribute('href', '/search?search=NHIS-000123')
})
