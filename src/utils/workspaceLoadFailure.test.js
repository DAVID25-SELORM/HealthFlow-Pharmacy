import { describe, expect, it } from 'vitest'
import {
  categorizeWorkspaceLoadFailure,
  describeWorkspaceLoadFailure,
  getLastWorkspaceLoadFailure,
  getRecentWorkspaceLoadFailures,
  recordWorkspaceLoadFailure,
} from './workspaceLoadFailure'

const memoryStorage = () => {
  const data = new Map()
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) }
}

describe('categorizing why the workspace could not load', () => {
  it.each([
    [{ name: 'NavigatorLockAcquireTimeoutError', message: 'x' }, 'SIGN_IN_LOCK'],
    [{ message: "Acquiring an exclusive Navigator LockManager lock timed out" }, 'SIGN_IN_LOCK'],
    [{ status: 429 }, 'RATE_LIMITED'],
    [{ status: 503 }, 'SERVER_ERROR'],
    [{ name: 'AbortError' }, 'NETWORK_TIMEOUT'],
    [{ message: 'Profile request timed out after 25000ms' }, 'NETWORK_TIMEOUT'],
    [{ message: 'TypeError: Failed to fetch' }, 'NETWORK_UNAVAILABLE'],
    [{ message: 'something unexpected' }, 'UNKNOWN_ERROR'],
    [null, 'UNKNOWN_ERROR'],
    ['PROFILE_MISSING', 'PROFILE_MISSING'],
    ['NOT_A_CATEGORY', 'UNKNOWN_ERROR'],
  ])('maps %j to %s', (error, expected) => {
    expect(categorizeWorkspaceLoadFailure(error)).toBe(expected)
  })

  it('has plain wording for every category, with a safe fallback', () => {
    expect(describeWorkspaceLoadFailure('NETWORK_TIMEOUT')).toMatch(/too long/)
    expect(describeWorkspaceLoadFailure('SIGN_IN_LOCK')).toMatch(/another HealthFlow tab/i)
    expect(describeWorkspaceLoadFailure('nope')).toBe(describeWorkspaceLoadFailure('UNKNOWN_ERROR'))
  })
})

describe('keeping the last failures on this device', () => {
  it('stores only the category and the time, never the error message', () => {
    const storage = memoryStorage()
    recordWorkspaceLoadFailure({ message: 'secret patient detail failed to fetch' }, { storage, now: Date.UTC(2026, 10, 15, 15, 30) })

    const [entry] = getRecentWorkspaceLoadFailures({ storage })
    expect(entry).toEqual({ at: '2026-11-15T15:30:00.000Z', category: 'NETWORK_UNAVAILABLE' })
    expect(JSON.stringify(entry)).not.toMatch(/secret|patient/)
  })

  it('keeps only the latest ten and returns the last one', () => {
    const storage = memoryStorage()
    for (let i = 0; i < 12; i += 1) recordWorkspaceLoadFailure({ status: i % 2 ? 503 : 429 }, { storage, now: 1000 + i })
    expect(getRecentWorkspaceLoadFailures({ storage })).toHaveLength(10)
    expect(getLastWorkspaceLoadFailure({ storage }).category).toBe('SERVER_ERROR')
  })

  it('never throws when storage is missing, blocked or holds garbage', () => {
    expect(() => recordWorkspaceLoadFailure({ status: 503 }, { storage: null })).not.toThrow()
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(recordWorkspaceLoadFailure({ status: 503 }, { storage: blocked })).toBe('SERVER_ERROR')
    expect(getLastWorkspaceLoadFailure({ storage: blocked })).toBeNull()
    const garbage = { getItem: () => 'not json', setItem: () => {} }
    expect(getRecentWorkspaceLoadFailures({ storage: garbage })).toEqual([])
  })
})
