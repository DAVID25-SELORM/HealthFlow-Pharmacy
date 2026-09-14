import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ClaimCorrectionAlerts from './ClaimCorrectionAlerts'

describe('correction alert summary', () => {
  it('starts compact, retains every issue, and lists shared blockers once', () => {
    const { container, rerender } = render(<ClaimCorrectionAlerts readiness={{
      serving: { blockers: ['Duration missing'] },
      export: { blockers: ['Duration missing', 'Prescription missing'], warnings: ['Check reference'] },
    }} />)
    expect(container.querySelector('details')).not.toHaveAttribute('open')
    expect(screen.getByRole('status')).toHaveTextContent('Serving Readiness: 1 blockers')
    expect(screen.getByRole('status')).toHaveTextContent('Export Readiness: 2 blockers')
    expect(screen.getAllByText('Duration missing')).toHaveLength(1)
    expect(screen.getByText('Prescription missing')).toBeInTheDocument()
    expect(screen.getByText('Check reference')).toBeInTheDocument()
    rerender(<ClaimCorrectionAlerts readiness={{ serving: { blockers: [] }, export: { blockers: [], warnings: [] } }} />)
    expect(screen.getByText('No remaining readiness alerts.')).toBeInTheDocument()
    expect(container.querySelector('details')).toBeNull()
  })
})
