// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveActivityLogPeriod } from '../_shared/activityLogPeriod.ts'

let readActivity
beforeAll(async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  const roleNames = ['ACTIVITY_LOG_ROLES', 'CLAIMS_ROLES', 'PATIENT_ROLES', 'INVENTORY_ROLES', 'SALES_ROLES', 'REPORT_ROLES']
  const roles = Object.fromEntries(roleNames.map((name) => {
    const literal = source.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\])`))[1]
    return [name, JSON.parse(literal.replaceAll("'", '"').replace(/,\s*\]/g, ']'))]
  }))
  const roleSource = source.slice(source.indexOf('const requesterHasAnyRole ='), source.indexOf('const isSuperAdminRequester ='))
  const roleBody = roleSource.slice(roleSource.indexOf('=>') + 2).trim()
  const hasRole = new Function('requesterProfile', 'roles', `return ${roleBody}`)
  const guardSource = source.slice(source.indexOf('const requireActivityLogAccess ='), source.indexOf('const requireOfflineInstallerDownloadAccess ='))
  const guardBody = guardSource.slice(guardSource.indexOf('=> {') + 3).trim()
  const requireActivityLogAccess = new Function('requesterHasAnyRole', 'ACTIVITY_LOG_ROLES', `return (requesterProfile) => ${guardBody}`)(hasRole, roles.ACTIVITY_LOG_ROLES)
  const handler = source.slice(source.indexOf('const getActivityLogs ='), source.indexOf('const getActiveOrganizations ='))
  const body = handler.slice(handler.indexOf(') => {') + 5).trim()
  const dependencies = { ...roles, requireActivityLogAccess, requesterHasAnyRole: hasRole, resolveActivityLogPeriod,
    normalizeText: (v) => String(v || '').trim(), parsePositiveInteger: (v, fallback) => Number(v) > 0 ? Number(v) : fallback,
    isSuperAdminRequester: (profile) => hasRole(profile, ['super_admin']) }
  // Execute the actual handler body, excluding Deno's unrelated HTTP bootstrap.
  readActivity = new Function(...Object.keys(dependencies), `return async (adminClient, requesterProfile, organizationId, payload) => ${body}`)(...Object.values(dependencies))
})
const profile = (role, extra = {}) => ({ role, assigned_roles: [], branch_id: 'server-branch', ...extra })
const client = () => ({ rpc: vi.fn().mockResolvedValue({ data: { logs: [], total: 0 }, error: null }) })

describe('Activity Log authenticated Edge boundary', () => {
  it('rejects staff without audit permission before querying', async () => {
    const db = client()
    await expect(readActivity(db, profile('cashier'), 'server-org', {})).rejects.toThrow('permission')
    expect(db.rpc).not.toHaveBeenCalled()
  })
  it('ignores browser-provided branch and clinical permission escalation', async () => {
    const db = client()
    await readActivity(db, profile('cashier', { can_view_activity_log: true }), 'server-org', { organizationId: 'foreign', branchId: 'foreign', permissions: { claim: true }, can_manage_claims: true, period: 'month', month: 9, year: 2026 })
    expect(db.rpc).toHaveBeenCalledWith('get_activity_log_view', expect.objectContaining({ p_organization_id: 'server-org', p_branch_id: 'server-branch', p_from_date: '2026-09-01', p_to_date: '2026-09-30' }))
    expect(db.rpc.mock.calls[0][1].p_permissions.claim).toBeFalsy()
  })
  it('uses persisted clinical permissions alongside audit access', async () => {
    const db = client()
    await readActivity(db, profile('cashier', { can_view_activity_log: true, can_manage_claims: true }), 'server-org', {})
    expect(db.rpc.mock.calls[0][1].p_permissions.claim).toBe(true)
  })
  it('keeps branch managers within their branch and does not grant claims access implicitly', async () => {
    const db = client()
    await readActivity(db, profile('branch_manager'), 'server-org', {})
    expect(db.rpc.mock.calls[0][1].p_branch_id).toBe('server-branch')
    expect(db.rpc.mock.calls[0][1].p_permissions.claim).toBeFalsy()
  })
})
