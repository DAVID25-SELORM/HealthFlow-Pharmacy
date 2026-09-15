import { expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ session: {} }))
vi.mock('../lib/supabase', () => ({ getCachedSupabaseSession: () => auth.session }))
import { createCoalescedCloudRead } from './coalesceCloudRead'

it('shares matching pending work, separates sessions/filters, and reloads after completion', async () => {
  const read = vi.fn().mockResolvedValue([])
  const coalesce = createCoalescedCloudRead()
  const first = coalesce('branch-a', read)
  expect(coalesce('branch-a', read)).toBe(first)
  const otherBranch = coalesce('branch-b', read)
  auth.session = {}
  const otherSession = coalesce('branch-a', read)
  expect(otherSession).not.toBe(first)
  await Promise.all([first, otherBranch, otherSession])
  expect(read).toHaveBeenCalledTimes(3)
  await coalesce('branch-a', read)
  expect(read).toHaveBeenCalledTimes(4)
})

it('does not retain failures or coalesce requests without a session', async () => {
  auth.session = {}
  const coalesce = createCoalescedCloudRead()
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
  await expect(coalesce('key', read)).rejects.toThrow('offline')
  await expect(coalesce('key', read)).resolves.toEqual([])
  auth.session = null
  await Promise.all([coalesce('key', read), coalesce('key', read)])
  expect(read).toHaveBeenCalledTimes(4)
})
