import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  value: {},
}))

vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../../context/TenantContext', () => ({
  useTenant: () => ({
    organization: { organization_type: 'pharmacy', name: 'Test Pharmacy' },
    canUseClaims: true,
    canUsePurchases: true,
    canUseNhis: true,
    canUseAccounting: true,
  }),
}))

import BottomNav from './BottomNav'
import Sidebar from './Sidebar'
import { groupNavigationItems, pickBottomTabs } from './useNavigationItems'

const fullAccess = {
  role: 'admin',
  assignedRoles: ['admin'],
  displayName: 'Test Admin',
  canManageInventory: true,
  canViewReports: true,
  canManageClaims: true,
  canManagePurchases: true,
  canProcessSales: true,
  canManagePatients: true,
  canManageAccounting: true,
  canManageEpharmacy: true,
  canViewActivityLog: true,
  canManageRestrictedInventory: false,
}

const item = (path, group, label = path) => ({ path, group, label, icon: () => null })

describe('navigation grouping', () => {
  it('lists only the groups that have items, in menu order', () => {
    const groups = groupNavigationItems([item('/settings', 'admin'), item('/sales', 'daily'), item('/inventory', 'stock')])
    expect(groups.map((g) => g.id)).toEqual(['daily', 'stock', 'admin'])
  })
})

describe('phone bottom tabs', () => {
  const all = ['/dashboard', '/sales', '/patients', '/inventory', '/nhis', '/claims', '/reports', '/settings'].map((p) => item(p, 'daily'))

  it('puts Sales in the raised middle slot between four everyday places', () => {
    const { tabs, raisedIndex, moreItems } = pickBottomTabs(all)
    expect(tabs.map((t) => t.tabLabel)).toEqual(['Home', 'Stock', 'Sales', 'NHIS'])
    expect(raisedIndex).toBe(2)
    expect(moreItems.map((m) => m.path)).toEqual(['/patients', '/claims', '/reports', '/settings'])
  })

  it('fills the NHIS slot with something else for a pharmacy without NHIS', () => {
    const { tabs } = pickBottomTabs(all.filter((i) => i.path !== '/nhis'))
    expect(tabs.map((t) => t.path)).toEqual(['/dashboard', '/inventory', '/sales', '/patients'])
  })

  it('never invents a tab the user cannot open, and does not raise Sales without a full row', () => {
    const { tabs, raisedIndex } = pickBottomTabs([item('/sales', 'daily'), item('/dashboard', 'daily')])
    expect(tabs.map((t) => t.path)).toEqual(['/dashboard', '/sales'])
    expect(raisedIndex).toBe(-1)
  })
})

describe('BottomNav', () => {
  beforeEach(() => {
    auth.value = fullAccess
  })

  const renderNav = (path = '/dashboard') => render(
    <MemoryRouter initialEntries={[path]}>
      <BottomNav />
    </MemoryRouter>
  )

  it('shows the everyday tabs and opens a grouped More sheet', () => {
    renderNav()
    const bar = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(bar).getByText('Home')).toBeTruthy()
    expect(within(bar).getByText('Stock')).toBeTruthy()
    expect(within(bar).getByText('Sales')).toBeTruthy()
    expect(within(bar).getByText('NHIS')).toBeTruthy()

    fireEvent.click(within(bar).getByRole('button', { name: /more/i }))
    const sheet = screen.getByRole('dialog', { name: 'More' })
    expect(within(sheet).getByText('Business')).toBeTruthy()
    expect(within(sheet).getByText('Admin')).toBeTruthy()
    expect(within(sheet).getByText('Patients')).toBeTruthy()
    expect(within(sheet).getByText('Settings')).toBeTruthy()
  })

  it('closes the sheet with the close button and the Escape key', () => {
    renderNav()
    fireEvent.click(screen.getByRole('button', { name: /more/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /more/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hides items the user has no permission for', () => {
    auth.value = { ...fullAccess, role: 'cashier', assignedRoles: [], canManageInventory: false, canViewReports: false, canManageClaims: false, canManagePurchases: false, canManagePatients: false, canManageAccounting: false, canManageEpharmacy: false, canViewActivityLog: false }
    renderNav()
    const bar = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(bar).queryByText('Stock')).toBeNull()
    expect(within(bar).getByText('Sales')).toBeTruthy()
  })
})

describe('Sidebar', () => {
  beforeEach(() => {
    auth.value = fullAccess
    window.localStorage.clear()
  })

  const renderSidebar = (props = {}, path = '/dashboard') => render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar isOpen={false} onClose={() => {}} onToggleCollapsed={() => {}} {...props} />
    </MemoryRouter>
  )

  it('groups the menu and folds Business and Admin by default', () => {
    renderSidebar()
    expect(screen.getByText('Daily work')).toBeTruthy()
    expect(screen.getByText('Stock')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Inventory/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Reports/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Business/ }))
    expect(screen.getByRole('link', { name: /Reports/ })).toBeTruthy()
  })

  it('keeps the group of the current page open', () => {
    renderSidebar({}, '/settings')
    expect(screen.getByRole('link', { name: /Settings/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Admin/ }).disabled).toBe(true)
  })

  it('collapses to an icon rail with labels kept for screen readers and hover', () => {
    const onToggle = vi.fn()
    renderSidebar({ collapsed: true, onToggleCollapsed: onToggle })
    expect(screen.queryByRole('button', { name: /Business/ })).toBeNull()
    const link = screen.getByRole('link', { name: 'Inventory' })
    expect(link.getAttribute('title')).toBe('Inventory')
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(onToggle).toHaveBeenCalled()
  })
})
