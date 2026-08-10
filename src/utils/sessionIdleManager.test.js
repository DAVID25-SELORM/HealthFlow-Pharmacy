import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSessionActivityStorageKey,
  recordSessionActivity,
  SESSION_IDLE_TIMEOUT_MS,
  startSessionIdleMonitor,
} from './sessionIdleManager'

describe('sessionIdleManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs out after 30 minutes without user activity', async () => {
    const onIdle = vi.fn()
    const stop = startSessionIdleMonitor({ userId: 'staff-1', onIdle })

    await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS - 1)
    expect(onIdle).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
    stop()
  })

  it('resets the timeout when the user interacts with the application', async () => {
    const onIdle = vi.fn()
    const stop = startSessionIdleMonitor({ userId: 'staff-2', onIdle })

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    window.dispatchEvent(new Event('pointerdown'))
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(onIdle).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    stop()
  })

  it('uses shared activity from another browser tab', async () => {
    const onIdle = vi.fn()
    const userId = 'staff-3'
    const stop = startSessionIdleMonitor({ userId, onIdle })

    await vi.advanceTimersByTimeAsync(25 * 60 * 1000)
    const key = getSessionActivityStorageKey(userId)
    window.localStorage.setItem(key, String(Date.now()))
    window.dispatchEvent(new StorageEvent('storage', { key }))
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(onIdle).not.toHaveBeenCalled()
    stop()
  })

  it('removes timers and event listeners when the session ends', async () => {
    const onIdle = vi.fn()
    const stop = startSessionIdleMonitor({ userId: 'staff-4', onIdle })
    stop()

    window.dispatchEvent(new Event('keydown'))
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('starts a fresh inactivity window after a successful new login', async () => {
    const userId = 'staff-5'
    const key = getSessionActivityStorageKey(userId)
    window.localStorage.setItem(key, '1')

    recordSessionActivity(userId, { timestamp: 12345 })

    expect(window.localStorage.getItem(key)).toBe('12345')
  })
})
