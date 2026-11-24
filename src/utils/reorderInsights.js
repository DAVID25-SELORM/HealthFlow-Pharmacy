// Reorder Centre phase 3: velocity, days of stock, price context, expiry warnings, priority.
// Every threshold is a named constant and every priority carries its reasons, so nothing
// here is an opaque score. Nothing is invented: too little history is reported as such.
import { STOCK_SEVERITY } from './reorderCentre'

// Sales window the database aggregates over (see get_reorder_insights).
export const USAGE_WINDOW_DAYS = 90
// Below this much history a usage rate would be a guess, so none is shown.
export const MIN_HISTORY_DAYS = 14
// A medicine that will run out within this many days at its current rate is "fast moving".
export const FAST_MOVING_DAYS = 14
// A purchase price change at or above this percentage is flagged (never blocked).
export const LARGE_PRICE_CHANGE_PERCENT = 20
// Used when the pharmacy has not configured an expiry alert window.
export const DEFAULT_EXPIRY_WINDOW_DAYS = 30

export const VELOCITY_STATUS = {
  OK: 'ok',
  INSUFFICIENT: 'insufficient', // too little history to say
  NO_SALES: 'no_sales', // enough history, but nothing sold in the window
}

const num = (value) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * @param {{unitsSold?: number, historyDays?: number}|null|undefined} insight  from get_reorder_insights
 * @param {number} quantity current stock
 */
export const computeVelocity = (insight, quantity) => {
  const historyDays = num(insight?.history_days ?? insight?.historyDays)
  const unitsSold = num(insight?.units_sold ?? insight?.unitsSold)
  if (historyDays === null || unitsSold === null || historyDays < MIN_HISTORY_DAYS) {
    return { status: VELOCITY_STATUS.INSUFFICIENT, avgDailyUsage: null, avgWeeklyUsage: null, daysOfStock: null }
  }
  const avgDailyUsage = unitsSold / historyDays
  if (avgDailyUsage <= 0) {
    return { status: VELOCITY_STATUS.NO_SALES, avgDailyUsage: 0, avgWeeklyUsage: 0, daysOfStock: null }
  }
  const stock = Math.max(0, Number.parseFloat(quantity) || 0)
  return {
    status: VELOCITY_STATUS.OK,
    avgDailyUsage,
    avgWeeklyUsage: avgDailyUsage * 7,
    daysOfStock: stock / avgDailyUsage,
  }
}

// ── Order sizing from sales ─────────────────────────────────────────────
// The default suggestion comes from the reorder and target levels. A pharmacy can also size an order from
// how fast a medicine really sells: enough to cover COVER days of sales, after what is in stock and on order.
export const SIZING_MODE = {
  LEVELS: 'levels', // the suggestion comes from reorder / target levels only (the original behaviour)
  LEVELS_AND_SALES: 'levels_and_sales', // the larger of the level-based and the sales-based quantity
}
export const DEFAULT_COVER_DAYS = 14
export const MIN_COVER_DAYS = 3
export const MAX_COVER_DAYS = 60

export const clampCoverDays = (value) => {
  const days = Number.parseInt(value, 10)
  if (!Number.isFinite(days)) return DEFAULT_COVER_DAYS
  return Math.min(MAX_COVER_DAYS, Math.max(MIN_COVER_DAYS, days))
}

// Units needed to cover `coverDays` of sales, after current stock and what is already on order. Null when
// there is not enough sales history to say (never a guess), and never negative.
export const getSalesBasedQuantity = (velocity, quantity, coverDays = DEFAULT_COVER_DAYS, alreadyOnOrder = 0) => {
  if (!velocity || velocity.status !== VELOCITY_STATUS.OK) return null
  const stock = Math.max(0, Number.parseFloat(quantity) || 0)
  const outstanding = Number.parseFloat(alreadyOnOrder) || 0
  return Math.max(0, Math.ceil(velocity.avgDailyUsage * clampCoverDays(coverDays) - stock - outstanding))
}

// Which quantity is suggested, and why. In the default mode the level-based quantity always wins.
export const chooseOrderQuantity = ({ levelBased, salesBased, mode }) => {
  if (mode === SIZING_MODE.LEVELS_AND_SALES && salesBased !== null && salesBased > levelBased) {
    return { quantity: salesBased, basis: 'sales' }
  }
  return { quantity: levelBased, basis: 'levels' }
}

export const isFastMoving = (velocity) =>
  velocity?.status === VELOCITY_STATUS.OK && velocity.daysOfStock <= FAST_MOVING_DAYS

export const describeVelocity = (velocity) => {
  if (!velocity || velocity.status === VELOCITY_STATUS.INSUFFICIENT) return 'Not enough data'
  if (velocity.status === VELOCITY_STATUS.NO_SALES) return 'No recent sales'
  const days = Math.floor(velocity.daysOfStock)
  return days <= 0 ? 'Under 1 day' : `${days} day${days === 1 ? '' : 's'}`
}

export const formatUsagePerDay = (velocity) => {
  if (!velocity || velocity.status !== VELOCITY_STATUS.OK) return '—'
  const value = velocity.avgDailyUsage
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}/day`
}

/**
 * Price context for a purchase: current vs previous cost. Large changes are flagged, never blocked.
 * @returns {{current: number, previous: number|null, changePercent: number|null, direction: 'up'|'down'|'flat'|null, flagged: boolean}|null}
 */
export const describePriceChange = (current, previous) => {
  const now = num(current)
  if (now === null || now <= 0) return null
  const before = num(previous)
  if (before === null || before <= 0) {
    return { current: now, previous: null, changePercent: null, direction: null, flagged: false }
  }
  const changePercent = ((now - before) / before) * 100
  const rounded = Math.round(changePercent * 10) / 10
  return {
    current: now,
    previous: before,
    changePercent: rounded,
    direction: rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat',
    flagged: Math.abs(changePercent) >= LARGE_PRICE_CHANGE_PERCENT,
  }
}

const money = (value) => `GHS ${Number(value).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const formatPriceChange = (change) => {
  if (!change) return ''
  if (change.previous === null) return `Last cost ${money(change.current)}`
  const sign = change.changePercent > 0 ? '+' : ''
  return `Last ${money(change.current)} · Previous ${money(change.previous)} · ${sign}${change.changePercent}%`
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Warns when stock on this row expires within the window. Not subtracted from the suggestion
 * automatically — staff decide whether to order less.
 * @returns {{kind: 'expired'|'expiring', units: number, daysLeft: number, message: string}|null}
 */
export const getExpiryWarning = (drug, windowDays = DEFAULT_EXPIRY_WINDOW_DAYS, now = new Date()) => {
  const units = Number.parseFloat(drug?.quantity) || 0
  if (units <= 0 || !drug?.expiry_date) return null
  const expiry = new Date(`${String(drug.expiry_date).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(expiry.getTime())) return null
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const daysLeft = Math.round((expiry.getTime() - today.getTime()) / DAY_MS)
  const window = Number.parseInt(windowDays, 10) || DEFAULT_EXPIRY_WINDOW_DAYS
  if (daysLeft < 0) {
    return { kind: 'expired', units, daysLeft, message: `${units} unit${units === 1 ? '' : 's'} already expired.` }
  }
  if (daysLeft > window) return null
  return {
    kind: 'expiring',
    units,
    daysLeft,
    message: `${units} unit${units === 1 ? '' : 's'} expire ${daysLeft === 0 ? 'today' : `within ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}.`,
  }
}

// ── Priority ─────────────────────────────────────────────────────────────────
//   1  out of stock
//   2  critical and fast moving
//   3  critical (slow or unknown speed), or low and fast moving
//   4  low and slow moving or unknown speed
// Anything else needs no priority. The reasons are returned so the page can show them.
export const PRIORITY_LABELS = { 1: 'Priority 1', 2: 'Priority 2', 3: 'Priority 3', 4: 'Priority 4' }

export const getReorderPriority = (severity, velocity) => {
  const fast = isFastMoving(velocity)
  const speed = fast ? 'fast moving' : velocity?.status === VELOCITY_STATUS.OK ? 'slow moving' : 'speed unknown'
  if (severity === STOCK_SEVERITY.OUT_OF_STOCK) {
    return { level: 1, reasons: ['Out of stock'] }
  }
  if (severity === STOCK_SEVERITY.CRITICAL) {
    return fast
      ? { level: 2, reasons: ['Critically low', 'Fast moving'] }
      : { level: 3, reasons: ['Critically low', speed.charAt(0).toUpperCase() + speed.slice(1)] }
  }
  if (severity === STOCK_SEVERITY.LOW) {
    return fast
      ? { level: 3, reasons: ['Low stock', 'Fast moving'] }
      : { level: 4, reasons: ['Low stock', speed.charAt(0).toUpperCase() + speed.slice(1)] }
  }
  return { level: null, reasons: [] }
}
