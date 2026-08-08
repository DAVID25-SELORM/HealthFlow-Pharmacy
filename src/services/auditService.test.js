import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentSupabaseUser: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  insert: vi.fn(),
  getStoredActiveRole: vi.fn(),
}))

const usersQuery = {
  select: vi.fn(() => usersQuery),
  eq: vi.fn(() => usersQuery),
  maybeSingle: mocks.maybeSingle,
}

const auditLogsQuery = {
  insert: mocks.insert,
}

vi.mock('../lib/supabase', () => ({
  getCurrentSupabaseUser: mocks.getCurrentSupabaseUser,
  supabase: {
    rpc: mocks.rpc,
    from: vi.fn((table) => {
      if (table === 'users') return usersQuery
      if (table === 'audit_logs') return auditLogsQuery
      return usersQuery
    }),
  },
}))

vi.mock('../utils/activeRole', () => ({
  getStoredActiveRole: mocks.getStoredActiveRole,
}))

import {
  flushPendingAuditEvents,
  getPendingAuditEventCount,
  logAuditEvent,
  tryLogAuditEvent,
  uuidOrNull,
} from './auditService'

describe('auditService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentSupabaseUser.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'claims@example.com',
    })
    mocks.maybeSingle.mockResolvedValue({
      data: { organization_id: '' },
      error: null,
    })
    mocks.rpc.mockResolvedValue({ error: null })
    mocks.insert.mockResolvedValue({ error: null })
    mocks.getStoredActiveRole.mockReturnValue('claims')
  })

  it('normalizes empty UUID values before calling the audit RPC', async () => {
    await logAuditEvent({
      eventType: 'nhis_claim.scrub_batch',
      entityType: 'nhis_claims',
      entityId: '',
      action: 'scrub_all_claims',
      details: {
        user_id: '',
        organization_id: '',
        branch_id: '22222222-2222-4222-8222-222222222222',
        count: 120,
      },
    })

    expect(mocks.rpc).toHaveBeenCalledWith('log_audit_event', {
      p_event_type: 'nhis_claim.scrub_batch',
      p_entity_type: 'nhis_claims',
      p_entity_id: null,
      p_action: 'scrub_all_claims',
      p_details: {
        active_role: 'claims',
        user_id: null,
        organization_id: null,
        branch_id: '22222222-2222-4222-8222-222222222222',
        count: 120,
      },
      p_organization_id: null,
    })
  })

  it('keeps audit logging non-blocking when the RPC fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.rpc.mockResolvedValue({
      error: {
        message: 'invalid input syntax for type uuid: ""',
      },
    })

    await expect(tryLogAuditEvent({
      eventType: 'nhis_claim.scrub_batch',
      entityType: 'nhis_claims',
      entityId: '',
      action: 'scrub_all_claims',
    })).resolves.toBeUndefined()

    expect(getPendingAuditEventCount()).toBe(0)
    warnSpy.mockRestore()
  })

  it('queues network audit failures and retries them after recovery', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.rpc
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ error: null })

    await expect(tryLogAuditEvent({
      eventType: 'nhis_claim.saved',
      entityType: 'nhis_claims',
      entityId: '11111111-1111-4111-8111-111111111111',
      action: 'save',
    })).resolves.toBeUndefined()

    expect(getPendingAuditEventCount()).toBe(1)
    await flushPendingAuditEvents()
    expect(getPendingAuditEventCount()).toBe(0)
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    errorSpy.mockRestore()
  })

  it('drops a permanently invalid queued event so later audit retries can continue', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.rpc
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ error: { code: '22023', message: 'Invalid audit payload' } })

    await tryLogAuditEvent({
      eventType: 'nhis_claim.saved',
      entityType: 'nhis_claims',
      entityId: '11111111-1111-4111-8111-111111111111',
      action: 'save',
    })

    expect(getPendingAuditEventCount()).toBe(1)
    await flushPendingAuditEvents()
    expect(getPendingAuditEventCount()).toBe(0)
    errorSpy.mockRestore()
  })

  it('returns null for blank UUID values', () => {
    expect(uuidOrNull('')).toBeNull()
    expect(uuidOrNull('   ')).toBeNull()
    expect(uuidOrNull(null)).toBeNull()
    expect(uuidOrNull('pending-nhis-claim')).toBeNull()
    expect(uuidOrNull('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111'
    )
  })
})
