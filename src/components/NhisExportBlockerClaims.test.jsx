import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NhisExportBlockerClaims from './NhisExportBlockerClaims'
afterEach(cleanup)
const claims = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, claim_number: `CLAIM-${i}`, patientName: `Patient ${i}`, issues: [`Missing attachment ${i}`] }))
const issue = { title: 'Missing attachments', claims: claims.slice(0, 8), readinessIssues: claims, total: 30 }
function mount(value = issue) {
  const onView = vi.fn(), onEdit = vi.fn()
  render(<NhisExportBlockerClaims issue={value} onView={onView} onEdit={onEdit} />)
  if (screen.queryByText(/Review affected claims/)) fireEvent.click(screen.getByText(/Review affected claims/))
  return { onView, onEdit }
}
describe('full export blocker claim list', () => {
  it('makes claims beyond the eight examples and first page accessible', () => {
    mount()
    expect(screen.getByText('Review affected claims (30)')).toBeInTheDocument()
    expect(screen.getByText('CLAIM-24')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Next claims'))
    expect(screen.getByText('CLAIM-29')).toBeInTheDocument()
    expect(screen.getByText('26-30 of 30 claims')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Previous claims'))
    expect(screen.getByText('CLAIM-0')).toBeInTheDocument()
  })
  it('searches the full list and opens the exact claim for view and edit', () => {
    const { onView, onEdit } = mount()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Missing attachment 29' } })
    expect(screen.getByText('1-1 of 1 claims')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View claim CLAIM-29' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit claim CLAIM-29' }))
    expect(onView).toHaveBeenCalledWith({ ...claims[29], _summaryOnly: true })
    expect(onEdit).toHaveBeenCalledWith({ ...claims[29], _summaryOnly: true })
  })
  it('reports a partial legacy payload and disables actions without an ID', () => {
    mount({ title: 'Legacy issue', claims: [{ claim_number: 'NO-ID' }], total: 20 })
    expect(screen.getByRole('status')).toHaveTextContent('Only 1 of 20')
    expect(screen.getByRole('button', { name: 'Edit claim NO-ID' })).toBeDisabled()
  })
  it('does not render an empty list for a configuration-only blocker', () => {
    mount({ title: 'Configuration', message: 'Configure facility' })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
