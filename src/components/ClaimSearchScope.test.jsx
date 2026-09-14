import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ClaimSearchScope from './ClaimSearchScope'

describe('claim search scope', () => {
  it('makes hidden history filters explicit and allows expanding a patient search', () => {
    function Search() {
      const [scope, setScope] = useState({ dateFilter: 'month', status: 'served', issueFilter: 'missing' })
      return <ClaimSearchScope search="member-123" {...scope} onShowAll={() => setScope({
        dateFilter: 'all', status: 'all', issueFilter: 'all',
      })} />
    }
    render(<Search />)
    expect(screen.getByRole('note')).toHaveTextContent('date, status, issue filters')
    fireEvent.click(screen.getByRole('button', { name: 'Search all dates and statuses' }))
    expect(screen.getByRole('note')).toHaveTextContent('Searching all dates and statuses within your permitted claims.')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not show a search notice before a search is entered', () => {
    render(<ClaimSearchScope search=" " dateFilter="month" status="all" issueFilter="all" />)
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
})
