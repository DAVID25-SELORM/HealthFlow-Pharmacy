import { describe, expect, it, vi } from 'vitest'
import { authorizeLocalOperationalRoute } from './localAuthorization.js'

const authorize = ({ path, method = 'GET', role, permissions = {}, body = {} }) => {
  const next = vi.fn()
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(value) {
      this.body = value
      return this
    },
  }
  authorizeLocalOperationalRoute({
    path,
    method,
    body,
    branchUser: { role, ...permissions },
  }, response, next)
  return { next, response }
}

describe('local operational authorization', () => {
  it('blocks a cashier from inventory mutation but permits POS inventory reads', () => {
    expect(authorize({
      path: '/api/inventory',
      role: 'cashier',
    }).next).toHaveBeenCalledOnce()
    expect(authorize({
      path: '/api/inventory/drug-1',
      method: 'DELETE',
      role: 'cashier',
    }).response.statusCode).toBe(403)
  })

  it('enforces explicit report and purchase approval privileges', () => {
    expect(authorize({
      path: '/api/reports/bundle',
      role: 'other',
      permissions: { canViewReports: true },
    }).next).toHaveBeenCalledOnce()
    expect(authorize({
      path: '/api/purchases/purchase-1',
      method: 'PUT',
      role: 'procurement',
      body: { status: 'completed' },
    }).response.statusCode).toBe(403)
    expect(authorize({
      path: '/api/purchases/purchase-1',
      method: 'PUT',
      role: 'procurement',
      permissions: { canApprovePurchases: true },
      body: { status: 'completed' },
    }).next).toHaveBeenCalledOnce()
  })

  it('reserves update and backup operations for administrators', () => {
    expect(authorize({
      path: '/api/updates/install',
      method: 'POST',
      role: 'branch_manager',
    }).response.statusCode).toBe(403)
    expect(authorize({
      path: '/api/database/backup',
      method: 'POST',
      role: 'admin',
    }).next).toHaveBeenCalledOnce()
  })
})
