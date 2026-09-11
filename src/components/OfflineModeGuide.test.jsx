import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import OfflineModeGuide from './OfflineModeGuide'
import { getOfflineModeSummary } from '../utils/offlineModeSummary'

const readyInput = () => ({
  config: { enabled: true, token: 'test' }, health: { ok: true },
  organizationId: 'org', branchId: 'branch',
  readiness: { ready: true, state: 'HEALTHY', organizationId: 'org', branchId: 'branch',
    snapshots: { inventory: { state: 'healthy' } }, staff: { offlinePinReady: 5, missingOfflinePin: 0 }, checks: [] },
})
const show = (input = {}, props = {}) => render(<OfflineModeGuide summary={getOfflineModeSummary(input)} canManage canRegister canInstall onPrepare={vi.fn()} onTest={vi.fn()} onRefresh={vi.fn()} {...props} />)

describe('Offline Mode guide', () => {
  it('starts with one setup action and keeps installation out of the initial view', () => {
    show()
    expect(screen.getByRole('heading', { name: 'Not Set Up' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download and Install' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set Up Offline Mode' }))
    expect(screen.getByRole('button', { name: 'Download and Install' })).toBeEnabled()
  })
  it('skips installation for a responding computer and shows facility connection', () => {
    show({ config: { enabled: true, token: 'test' }, health: { ok: true } }, { setupFields: <button>Connect Facility</button> })
    fireEvent.click(screen.getByRole('button', { name: 'Set Up Offline Mode' }))
    expect(screen.getByText(/Installation is already complete/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Facility' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download and Install' })).not.toBeInTheDocument()
  })
  it('does not offer reinstallation when a configured computer is unreachable', () => {
    show({ config: { enabled: true, token: 'test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set Up Offline Mode' }))
    expect(screen.getByText(/Check its power and your network/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download and Install' })).not.toBeInTheDocument()
  })
  it('offers preparation and an actionable missing inventory message', () => {
    const input = readyInput(); input.readiness.ready = false
    input.readiness.checks = [{ id: 'inventory_snapshot', required: true, passed: false, detail: 'raw SQL secret' }]
    const prepare = vi.fn(); show(input, { onPrepare: prepare })
    fireEvent.click(screen.getByRole('button', { name: 'Prepare Offline Mode' }))
    expect(prepare).toHaveBeenCalledOnce()
    expect(screen.getByText(/Inventory data has not been downloaded/)).toBeInTheDocument()
    expect(screen.queryByText('raw SQL secret')).not.toBeInTheDocument()
  })
  it('requires a passing test before showing final readiness', () => {
    const input = readyInput()
    expect(getOfflineModeSummary(input).setupStatus).toBe('Ready to Test')
    show({ ...input, test: { passed: true, organizationId: 'org', branchId: 'branch' } })
    expect(screen.getByRole('heading', { name: 'Offline Mode Ready' })).toBeInTheDocument()
    expect(screen.getByText('5 staff ready. 0 staff need offline access or an Offline PIN.')).toBeInTheDocument()
  })
  it.each([
    [{ internetAvailable: true }, 'Online'],
    [{ internetAvailable: false }, 'Offline — Local Server'],
    [{ busy: 'sync' }, 'Synchronizing'],
    [{ status: { failed: 3 } }, 'Attention Required'],
  ])('shows the daily state %s', (extra, label) => {
    show({ ...readyInput(), ...extra })
    expect(screen.getByRole('status')).toHaveTextContent(label)
  })
  it('routes failed work to the existing administrator workflow', () => {
    const issues = vi.fn(); show({ ...readyInput(), status: { failed: 3 } }, { onIssues: issues })
    fireEvent.click(screen.getByRole('button', { name: 'Fix Sync Issues' }))
    expect(issues).toHaveBeenCalledOnce()
  })
  it('keeps technical and repair controls away from ordinary staff', () => {
    show({ ...readyInput(), status: { failed: 3 } }, { canManage: false })
    expect(screen.queryByRole('button', { name: 'Fix Sync Issues' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Advanced/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View Staff Readiness' })).not.toBeInTheDocument()
  })
  it('invalidates readiness when data ages or the facility changes', () => {
    const input = { ...readyInput(), test: { passed: true, organizationId: 'org', branchId: 'branch' } }
    input.readiness.snapshots.inventory.state = 'degraded'
    expect(getOfflineModeSummary(input)).toMatchObject({ ready: false, data: 'Needs Refresh' })
    input.readiness.snapshots.inventory.state = 'healthy'
    expect(getOfflineModeSummary({ ...input, branchId: 'other' }).ready).toBe(false)
    input.readiness.state = 'ACTION_REQUIRED'
    expect(getOfflineModeSummary(input).ready).toBe(false)
  })
  it('explains a backup failure even when data snapshots are current', () => {
    const input = readyInput()
    input.readiness.state = 'ACTION_REQUIRED'
    input.readiness.backups = { state: 'critical' }
    show(input)
    expect(screen.getByText(/Local backup protection needs attention/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Offline Mode Ready' })).not.toBeInTheDocument()
  })
  it('does not show a passing test message from another facility', () => {
    const test = { passed: true, organizationId: 'other', branchId: 'other' }
    show({ ...readyInput(), test }, { test })
    expect(screen.queryByText('Offline test passed. Offline Mode Ready.')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ready to Test' })).toBeInTheDocument()
  })

})
