import { describe, expect, it, vi } from 'vitest'
import { WORKSPACE_RELOAD_COOLDOWN_MS, reloadWorkspaceOnce } from './workspaceAutoReload'

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial))
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) }
}

describe('reloading the workspace page once', () => {
  it('reloads when online and not reloaded recently, and remembers the time', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    expect(reloadWorkspaceOnce({ now: 1_000_000, storage, reload, online: true })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.getItem('healthflow_workspace_reload_at')).toBe('1000000')
  })

  it('does not reload again inside the cooldown, so it can never loop', () => {
    const storage = memoryStorage({ healthflow_workspace_reload_at: '1000000' })
    const reload = vi.fn()
    expect(reloadWorkspaceOnce({ now: 1_000_000 + WORKSPACE_RELOAD_COOLDOWN_MS - 1, storage, reload, online: true })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(reloadWorkspaceOnce({ now: 1_000_000 + WORKSPACE_RELOAD_COOLDOWN_MS, storage, reload, online: true })).toBe(true)
  })

  it('does not reload while the device is offline', () => {
    const reload = vi.fn()
    expect(reloadWorkspaceOnce({ now: 1, storage: memoryStorage(), reload, online: false })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('never reloads when the cooldown cannot be kept (storage blocked)', () => {
    const reload = vi.fn()
    const blockedWrite = { getItem: () => null, setItem: () => { throw new Error('blocked') } }
    expect(reloadWorkspaceOnce({ now: 1, storage: blockedWrite, reload, online: true })).toBe(false)
    const blockedRead = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }
    expect(reloadWorkspaceOnce({ now: 1, storage: blockedRead, reload, online: true })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
