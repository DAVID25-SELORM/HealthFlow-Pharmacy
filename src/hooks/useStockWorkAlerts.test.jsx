import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({ supabase: {} }))
vi.mock('../services/branchStockRequestService', () => ({ countStockWork: vi.fn() }))

import { countStockWork } from '../services/branchStockRequestService'
import { dispatchHealthflowDataChanged } from '../lib/appEvents'
import { useStockWorkAlerts } from './useStockWorkAlerts'

const actor = { userId: 'u1', branchId: 'main', isAdmin: false, isManager: true }

describe('useStockWorkAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    countStockWork.mockResolvedValue({ requestsToDecide: 2, transfersToConfirm: 1 })
  })
  afterEach(() => vi.useRealTimers())

  it('offers a bell item for requests to decide and for transfers to confirm', async () => {
    const { result } = renderHook(() => useStockWorkAlerts({ enabled: true, actor }))
    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(result.current[0]).toMatchObject({ id: 'stock-requests', count: 2, path: '/stock-transfers?view=requests' })
    expect(result.current[1]).toMatchObject({ id: 'transfers-to-confirm', count: 1, path: '/stock-transfers' })
  })

  it('shows nothing, and does not query, when switched off', async () => {
    const { result } = renderHook(() => useStockWorkAlerts({ enabled: false, actor }))
    expect(result.current).toEqual([])
    expect(countStockWork).not.toHaveBeenCalled()
  })

  it('leaves out an item that has nothing waiting', async () => {
    countStockWork.mockResolvedValue({ requestsToDecide: 0, transfersToConfirm: 3 })
    const { result } = renderHook(() => useStockWorkAlerts({ enabled: true, actor }))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe('transfers-to-confirm')
  })

  it('refreshes when app data changes, and clears the items when nothing is waiting any more', async () => {
    const { result } = renderHook(() => useStockWorkAlerts({ enabled: true, actor }))
    await waitFor(() => expect(result.current).toHaveLength(2))
    countStockWork.mockResolvedValue({ requestsToDecide: 0, transfersToConfirm: 0 })
    act(() => dispatchHealthflowDataChanged())
    await waitFor(() => expect(result.current).toEqual([]))
  })

  it('refreshes every two minutes while the page is visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderHook(() => useStockWorkAlerts({ enabled: true, actor }))
    await waitFor(() => expect(countStockWork).toHaveBeenCalledTimes(1))
    await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
    expect(countStockWork).toHaveBeenCalledTimes(2)
  })

  it('stops refreshing once it is unmounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { unmount } = renderHook(() => useStockWorkAlerts({ enabled: true, actor }))
    await waitFor(() => expect(countStockWork).toHaveBeenCalledTimes(1))
    unmount()
    await vi.advanceTimersByTimeAsync(240000)
    expect(countStockWork).toHaveBeenCalledTimes(1)
  })
})
