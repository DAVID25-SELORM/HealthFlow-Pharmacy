import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceRecovery } from './workspaceRecovery'
afterEach(() => vi.useRealTimers())

it('bounds retries and still allows reconnect/manual recovery after exhaustion', async () => {
  vi.useFakeTimers()
  const retry = vi.fn().mockResolvedValue(undefined)
  const recovery = createWorkspaceRecovery(retry)
  recovery.update(true)
  await vi.advanceTimersByTimeAsync(60000)
  expect(retry).toHaveBeenCalledTimes(3)
  await recovery.retry()
  expect(retry).toHaveBeenCalledTimes(4)
  recovery.update(false)
  await recovery.retry()
  await vi.advanceTimersByTimeAsync(60000)
  expect(retry).toHaveBeenCalledTimes(4)
  recovery.stop()
})

it('does not overlap reconnect and timer work, and cancels on unmount', async () => {
  vi.useFakeTimers()
  let finish
  const retry = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  const recovery = createWorkspaceRecovery(retry)
  recovery.update(true)
  const pending = recovery.retry()
  await recovery.retry()
  await vi.advanceTimersByTimeAsync(60000)
  expect(retry).toHaveBeenCalledTimes(1)
  recovery.stop()
  finish()
  await pending
  await vi.advanceTimersByTimeAsync(60000)
  expect(retry).toHaveBeenCalledTimes(1)
})
