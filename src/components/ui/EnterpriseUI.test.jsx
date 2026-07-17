import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  DataTable,
  EmptyState,
  FormSection,
  IconButton,
  LoadingState,
  ModalShell,
  PageHeader,
  StatCard,
  StatusBadge,
  Toolbar,
} from './EnterpriseUI'

describe('enterprise UI primitives', () => {
  it('renders page and toolbar primitives', () => {
    render(
      <>
        <PageHeader eyebrow="Operations" title="Inventory" description="Manage medicines." />
        <Toolbar title="Filters" actions={<button type="button">Apply</button>}>
          <input aria-label="Search" />
        </Toolbar>
      </>
    )

    expect(screen.getByText('Operations')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Inventory' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Filters' })).toBeInTheDocument()
  })

  it('renders data table rows and empty/loading states', () => {
    const columns = [
      { key: 'name', header: 'Name' },
      { key: 'status', header: 'Status', render: (row) => <StatusBadge tone="success">{row.status}</StatusBadge> },
    ]

    const { rerender } = render(<DataTable columns={columns} rows={[{ id: '1', name: 'Paracetamol', status: 'Active' }]} />)
    expect(screen.getByText('Paracetamol')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()

    rerender(<DataTable columns={columns} rows={[]} emptyState={<EmptyState title="No medicines" />} />)
    expect(screen.getByText('No medicines')).toBeInTheDocument()

    rerender(<DataTable columns={columns} rows={[]} loading />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders form, stat, icon button, loading, and modal primitives', () => {
    render(
      <>
        <StatCard label="Claims" value="42" meta="This month" />
        <FormSection title="Patient details">
          <input aria-label="Surname" />
        </FormSection>
        <IconButton label="Refresh">R</IconButton>
        <LoadingState title="Checking" />
        <ModalShell open title="Confirm" footer={<button type="button">Save</button>} onClose={() => {}}>
          <p>Review changes.</p>
        </ModalShell>
      </>
    )

    expect(screen.getByText('Claims')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Patient details' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeInTheDocument()
  })
})
