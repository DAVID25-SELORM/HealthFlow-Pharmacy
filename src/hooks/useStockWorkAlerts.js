import { useEffect, useMemo, useState } from 'react'
import { subscribeToHealthflowDataChanged } from '../lib/appEvents'
import { countStockWork } from '../services/branchStockRequestService'

const REFRESH_MS = 120000
const NONE = { requestsToDecide: 0, transfersToConfirm: 0 }

// Two notification-bell items for Multi-branch pharmacies: stock requests waiting for this person's
// decision, and transfers waiting for them to confirm. Refreshes every two minutes while the page is
// visible and whenever app data changes. Returns [] when there is nothing to do or it is switched off.
export function useStockWorkAlerts({ enabled, actor }) {
  const [counts, setCounts] = useState(NONE)
  const actorKey = actor ? `${actor.userId}|${actor.branchId}|${actor.isAdmin}|${actor.isManager}` : ''

  useEffect(() => {
    if (!enabled || !actor) {
      setCounts(NONE)
      return undefined
    }
    let cancelled = false
    const load = async () => {
      const next = await countStockWork(actor)
      if (!cancelled) setCounts(next)
    }
    load()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') load()
    }, REFRESH_MS)
    const unsubscribe = subscribeToHealthflowDataChanged(load)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      unsubscribe()
    }
    // actorKey stands for the parts of `actor` that matter
  }, [enabled, actorKey])

  return useMemo(() => {
    const items = []
    if (counts.requestsToDecide > 0) {
      items.push({
        id: 'stock-requests',
        title: 'Stock requests to decide',
        description: `${counts.requestsToDecide} request(s) for stock are waiting for you.`,
        count: counts.requestsToDecide,
        path: '/stock-transfers?view=requests',
      })
    }
    if (counts.transfersToConfirm > 0) {
      items.push({
        id: 'transfers-to-confirm',
        title: 'Transfers to confirm',
        description: `${counts.transfersToConfirm} transfer(s) are on their way and need you to confirm receipt.`,
        count: counts.transfersToConfirm,
        path: '/stock-transfers',
      })
    }
    return items
  }, [counts])
}
