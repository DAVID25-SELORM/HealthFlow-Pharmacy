import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Package,
  RefreshCcw,
  Search,
  ShoppingCart,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { getAllDrugs } from '../services/drugService'
import { getPharmacySettings } from '../services/settingsService'
import { getOpenOrderQuantitiesByDrug, loadReorderInsights } from '../services/purchasesApi'
import {
  NO_SUPPLIER_GROUP_KEY,
  STOCK_SEVERITY,
  buildReorderLineItem,
  getEffectiveTargetStockLevel,
  getEstimatedReorderValue,
  getReorderLevel,
  getStockSeverity,
  getStockSeverityBadgeClass,
  getStockSeverityLabel,
  groupReorderItemsBySupplier,
  needsReorderAttention,
} from '../utils/reorderCentre'
import {
  DEFAULT_EXPIRY_WINDOW_DAYS,
  PRIORITY_LABELS,
  USAGE_WINDOW_DAYS,
  computeVelocity,
  describePriceChange,
  describeVelocity,
  formatPriceChange,
  formatUsagePerDay,
  getExpiryWarning,
  getReorderPriority,
} from '../utils/reorderInsights'
import './ReorderCentre.css'

const SEVERITY_FILTERS = [
  { value: 'all', label: 'All' },
  { value: STOCK_SEVERITY.OUT_OF_STOCK, label: 'Out of Stock' },
  { value: STOCK_SEVERITY.CRITICAL, label: 'Critical' },
  { value: STOCK_SEVERITY.LOW, label: 'Low Stock' },
  { value: 'already_on_order', label: 'Already on Order' },
]

const SORT_OPTIONS = [
  { value: 'urgency', label: 'Most urgent' },
  { value: 'lowest_stock', label: 'Lowest stock' },
  { value: 'highest_value', label: 'Highest estimated value' },
  { value: 'fastest_moving', label: 'Fastest moving' },
  { value: 'supplier', label: 'Supplier' },
]

const fmtCurrency = (value) =>
  `GHS ${Number(value || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Days of stock left, unknown last (an unknown speed must never outrank a known emergency).
const daysOrInfinity = (row) => (row.velocity.daysOfStock == null ? Number.POSITIVE_INFINITY : row.velocity.daysOfStock)

const ReorderCentre = () => {
  const { canManagePurchases } = useAuth()
  const { notify } = useNotification()
  const navigate = useNavigate()

  const [drugs, setDrugs] = useState([])
  const [openOrderQuantities, setOpenOrderQuantities] = useState(new Map())
  const [insights, setInsights] = useState(new Map())
  const [insightsUnavailable, setInsightsUnavailable] = useState(false)
  const [expiryWindowDays, setExpiryWindowDays] = useState(DEFAULT_EXPIRY_WINDOW_DAYS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [supplierFilter, setSupplierFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [sortBy, setSortBy] = useState('urgency')
  // Supplier assigned in this session for a medicine that has none on file yet,
  // keyed by drug id. Nothing is written back to the drug until an order for it
  // is actually created (Purchases still lets staff change it before saving).
  const [assignedSuppliers, setAssignedSuppliers] = useState({})

  const load = async () => {
    try {
      setLoading(true)
      setError('')
      const [drugRows, openOrders, settings] = await Promise.all([
        getAllDrugs({ useTierAccess: true }),
        getOpenOrderQuantitiesByDrug().catch((loadError) => {
          console.warn('Unable to load open purchase order quantities:', loadError)
          return new Map()
        }),
        getPharmacySettings().catch(() => null),
      ])
      setDrugs(drugRows)
      setOpenOrderQuantities(openOrders)
      setExpiryWindowDays(Number.parseInt(settings?.expiry_alert_days, 10) || DEFAULT_EXPIRY_WINDOW_DAYS)

      // Velocity and price history are extras: if they cannot be loaded the page still works.
      try {
        const ids = drugRows.filter(needsReorderAttention).map((drug) => drug.id)
        setInsights(ids.length ? await loadReorderInsights(ids, USAGE_WINDOW_DAYS) : new Map())
        setInsightsUnavailable(false)
      } catch (insightsError) {
        console.warn('Unable to load reorder insights:', insightsError)
        setInsights(new Map())
        setInsightsUnavailable(true)
      }
    } catch (loadError) {
      setError(loadError.message || 'Unable to load the Reorder Centre.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (canManagePurchases) void load()
  }, [canManagePurchases])

  const rows = useMemo(() => {
    return drugs
      .filter(needsReorderAttention)
      .map((drug) => {
        const alreadyOnOrder = openOrderQuantities.get(drug.id)?.quantity || 0
        const severity = getStockSeverity(drug)
        const suggestedQuantity = buildReorderLineItem(drug, alreadyOnOrder).suggestedQuantity
        const insight = insights.get(drug.id) || null
        const velocity = computeVelocity(insight, drug.quantity)
        const priceChange = describePriceChange(insight?.last_cost, insight?.previous_cost)
        // Supplier: what staff assigned here, else the one on the medicine, else the one it
        // was last bought from. Always just a suggestion — Purchases lets staff change it.
        const assigned = assignedSuppliers[drug.id]
        const onFile = drug.supplier || ''
        const lastBoughtFrom = insight?.last_supplier || ''
        const supplier = assigned ?? (onFile || lastBoughtFrom)
        const supplierSource = assigned !== undefined ? 'assigned' : onFile ? 'medicine' : lastBoughtFrom ? 'last_purchase' : 'none'
        return {
          drug,
          severity,
          alreadyOnOrder,
          suggestedQuantity,
          supplier,
          supplierSource,
          velocity,
          priceChange,
          priority: getReorderPriority(severity, velocity),
          expiryWarning: getExpiryWarning(drug, expiryWindowDays),
          estimatedValue: getEstimatedReorderValue(drug, suggestedQuantity),
          targetStockLevel: getEffectiveTargetStockLevel(drug),
          reorderLevel: getReorderLevel(drug),
        }
      })
  }, [drugs, openOrderQuantities, insights, assignedSuppliers, expiryWindowDays])

  const supplierOptions = useMemo(
    () => [...new Set(rows.map((row) => row.supplier).filter(Boolean))].sort(),
    [rows]
  )
  const categoryOptions = useMemo(
    () => [...new Set(rows.map((row) => row.drug.category).filter(Boolean))].sort(),
    [rows]
  )

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return rows.filter((row) => {
      const { drug } = row
      const matchesSearch =
        !term ||
        [drug.name, drug.brand_name, drug.generic_name, row.supplier]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(term))
      const matchesSeverity =
        severityFilter === 'all' ||
        (severityFilter === 'already_on_order' ? row.alreadyOnOrder > 0 : row.severity === severityFilter)
      const matchesSupplier = supplierFilter === 'all' || row.supplier === supplierFilter
      const matchesCategory = categoryFilter === 'all' || drug.category === categoryFilter
      return matchesSearch && matchesSeverity && matchesSupplier && matchesCategory
    })
  }, [rows, searchTerm, severityFilter, supplierFilter, categoryFilter])

  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows]
    if (sortBy === 'lowest_stock') {
      sorted.sort((a, b) => (a.drug.quantity ?? 0) - (b.drug.quantity ?? 0))
    } else if (sortBy === 'highest_value') {
      sorted.sort((a, b) => b.estimatedValue - a.estimatedValue)
    } else if (sortBy === 'fastest_moving') {
      // Known usage first (highest first); medicines with unknown speed go last, not first.
      sorted.sort((a, b) => (b.velocity.avgDailyUsage ?? -1) - (a.velocity.avgDailyUsage ?? -1))
    } else if (sortBy === 'supplier') {
      sorted.sort((a, b) => (a.supplier || '￿').localeCompare(b.supplier || '￿'))
    } else {
      // Most urgent: priority level, then how soon it runs out, then how little is left.
      sorted.sort((a, b) => {
        const byPriority = (a.priority.level ?? 9) - (b.priority.level ?? 9)
        if (byPriority !== 0) return byPriority
        const byDays = daysOrInfinity(a) - daysOrInfinity(b)
        if (byDays !== 0 && !Number.isNaN(byDays)) return byDays
        return (a.drug.quantity ?? 0) - (b.drug.quantity ?? 0)
      })
    }
    return sorted
  }, [filteredRows, sortBy])

  const supplierGroups = useMemo(
    () => groupReorderItemsBySupplier(sortedRows.filter((row) => row.suggestedQuantity > 0)),
    [sortedRows]
  )

  const totalEstimatedValue = filteredRows.reduce((sum, row) => sum + row.estimatedValue, 0)
  const severityCounts = {
    [STOCK_SEVERITY.OUT_OF_STOCK]: rows.filter((row) => row.severity === STOCK_SEVERITY.OUT_OF_STOCK).length,
    [STOCK_SEVERITY.CRITICAL]: rows.filter((row) => row.severity === STOCK_SEVERITY.CRITICAL).length,
    [STOCK_SEVERITY.LOW]: rows.filter((row) => row.severity === STOCK_SEVERITY.LOW).length,
  }

  const assignSupplier = (drugId, value) => {
    setAssignedSuppliers((current) => ({ ...current, [drugId]: value }))
  }

  const createOrderForGroup = (group) => {
    if (!group.supplier) {
      notify('Assign a supplier to these medicines before creating an order.', 'warning')
      return
    }
    const reorderItems = group.items.map((row) =>
      buildReorderLineItem(row.drug, row.alreadyOnOrder, group.supplier, {
        priceNote: formatPriceChange(row.priceChange),
        priceFlagged: Boolean(row.priceChange?.flagged),
      })
    )
    navigate('/purchases', { state: { reorderItems } })
  }

  if (!canManagePurchases) {
    return (
      <div className="reorder-centre-page">
        <p className="reorder-centre-empty">You do not have permission to view the Reorder Centre.</p>
      </div>
    )
  }

  return (
    <div className="reorder-centre-page">
      <div className="page-header">
        <div>
          <h1>Reorder Centre</h1>
          <p>Everything that needs restocking, grouped by supplier, with a suggested quantity for each.</p>
        </div>
        <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
          <RefreshCcw size={18} />
          Refresh
        </button>
      </div>

      {error && <div className="reorder-centre-alert" role="alert">{error}</div>}
      {insightsUnavailable && !loading && (
        <div className="reorder-centre-note" role="status">
          Sales speed and price history could not be loaded, so days of stock and price changes are hidden.
          Everything else still works.
        </div>
      )}

      {loading ? (
        <div className="reorder-centre-loading">Loading the Reorder Centre...</div>
      ) : rows.length === 0 ? (
        <div className="reorder-centre-empty">
          <Package size={40} />
          <p>Nothing needs restocking right now.</p>
        </div>
      ) : (
        <>
          <div className="reorder-centre-summary">
            <div className="reorder-summary-card severity-out-of-stock">
              <span className="reorder-summary-value">{severityCounts[STOCK_SEVERITY.OUT_OF_STOCK]}</span>
              <span className="reorder-summary-label">Out of stock</span>
            </div>
            <div className="reorder-summary-card severity-critical">
              <span className="reorder-summary-value">{severityCounts[STOCK_SEVERITY.CRITICAL]}</span>
              <span className="reorder-summary-label">Critical</span>
            </div>
            <div className="reorder-summary-card severity-low">
              <span className="reorder-summary-value">{severityCounts[STOCK_SEVERITY.LOW]}</span>
              <span className="reorder-summary-label">Low stock</span>
            </div>
            <div className="reorder-summary-card">
              <span className="reorder-summary-value">{fmtCurrency(totalEstimatedValue)}</span>
              <span className="reorder-summary-label">Estimated replenishment (filtered)</span>
            </div>
          </div>

          <div className="reorder-centre-controls">
            <div className="reorder-filter-tabs">
              {SEVERITY_FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`reorder-filter-tab ${severityFilter === option.value ? 'active' : ''}`}
                  onClick={() => setSeverityFilter(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="reorder-centre-search">
              <Search size={16} />
              <input
                type="text"
                placeholder="Search medicine or supplier..."
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
            <select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}>
              <option value="all">All suppliers</option>
              {supplierOptions.map((supplier) => (
                <option key={supplier} value={supplier}>{supplier}</option>
              ))}
            </select>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="all">All categories</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>Sort: {option.label}</option>
              ))}
            </select>
          </div>

          <div className="reorder-centre-table-wrap">
            <table className="reorder-centre-table">
              <thead>
                <tr>
                  <th>Medicine</th>
                  <th>Current</th>
                  <th>Reorder level</th>
                  <th>Target</th>
                  <th>On order</th>
                  <th>Suggested qty</th>
                  <th>Est. value</th>
                  <th>Supplier</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="reorder-centre-no-results">No medicines match the current filters.</td>
                  </tr>
                ) : (
                  sortedRows.map((row) => (
                    <tr key={row.drug.id}>
                      <td data-label="Medicine">
                        <div className="reorder-drug-name">{row.drug.name}</div>
                        {(row.drug.brand_name || row.drug.generic_name) && (
                          <div className="reorder-drug-subtext">
                            {[row.drug.brand_name, row.drug.generic_name].filter(Boolean).join(' · ')}
                          </div>
                        )}
                        {row.expiryWarning && (
                          <div className={`reorder-expiry-warning reorder-expiry-warning--${row.expiryWarning.kind}`}>
                            <AlertTriangle size={12} /> {row.expiryWarning.message}
                          </div>
                        )}
                      </td>
                      <td data-label="Current stock">
                        <div>{row.drug.quantity ?? 0}</div>
                        {!insightsUnavailable && (
                          <div className="reorder-drug-subtext" title={`Based on completed sales over the last ${USAGE_WINDOW_DAYS} days`}>
                            {describeVelocity(row.velocity)}
                            {row.velocity.avgDailyUsage > 0 && ` · ${formatUsagePerDay(row.velocity)}`}
                          </div>
                        )}
                      </td>
                      <td data-label="Reorder level">{row.reorderLevel}</td>
                      <td data-label="Target stock level">{row.targetStockLevel}</td>
                      <td data-label="Already on order">{row.alreadyOnOrder || '-'}</td>
                      <td data-label="Suggested quantity">{row.suggestedQuantity}</td>
                      <td data-label="Estimated value">
                        <div>{fmtCurrency(row.estimatedValue)}</div>
                        {row.priceChange && (
                          <div
                            className={`reorder-drug-subtext ${row.priceChange.flagged ? 'reorder-price-flagged' : ''}`}
                            title={row.priceChange.flagged ? 'Unusually large price change since the previous purchase' : undefined}
                          >
                            {formatPriceChange(row.priceChange)}
                          </div>
                        )}
                      </td>
                      <td data-label="Supplier">
                        {drugSupplierCell(row, assignSupplier)}
                      </td>
                      <td data-label="Stock status">
                        <span className={`reorder-severity-badge ${getStockSeverityBadgeClass(row.severity)}`}>
                          {getStockSeverityLabel(row.severity)}
                        </span>
                        {row.priority.level && (
                          <div
                            className={`reorder-priority reorder-priority--${row.priority.level}`}
                            title={row.priority.reasons.join(' · ')}
                          >
                            {PRIORITY_LABELS[row.priority.level]}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <section className="reorder-supplier-groups">
            <h2>Create purchase orders by supplier</h2>
            <p className="reorder-supplier-groups-hint">
              One order per supplier — medicines with no supplier are grouped separately until you assign one.
              Only medicines that still need more than what's already on order are included.
            </p>
            {supplierGroups.length === 0 ? (
              <p className="reorder-centre-empty-inline">No medicines currently need ordering.</p>
            ) : (
              supplierGroups.map((group) => (
                <div key={group.supplier || NO_SUPPLIER_GROUP_KEY} className="reorder-supplier-group">
                  <div className="reorder-supplier-group-header">
                    <div>
                      <strong>{group.supplier || 'Supplier required'}</strong>
                      <span>{group.items.length} medicine{group.items.length === 1 ? '' : 's'}</span>
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      disabled={!group.supplier}
                      title={group.supplier ? undefined : 'Assign a supplier to every medicine in this group first'}
                      onClick={() => createOrderForGroup(group)}
                    >
                      <ShoppingCart size={16} />
                      Create Purchase Order
                    </button>
                  </div>
                  <ul className="reorder-supplier-group-items">
                    {group.items.map((row) => (
                      <li key={row.drug.id}>
                        {row.drug.name} — {row.suggestedQuantity} {row.drug.unit || 'unit'}
                        {row.supplierSource === 'last_purchase' && (
                          <span className="reorder-supplier-hint">supplier from last purchase</span>
                        )}
                        {!group.supplier && (
                          <span className="reorder-supplier-required">
                            <AlertTriangle size={14} /> Supplier required
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  )
}

// Kept as a small helper (not a component) so the input's value/onChange stay
// obviously tied to this exact row without an extra prop-drilled component file.
function drugSupplierCell(row, assignSupplier) {
  return (
    <>
      <input
        type="text"
        className="reorder-supplier-input"
        placeholder="Assign supplier"
        value={row.supplier}
        onChange={(event) => assignSupplier(row.drug.id, event.target.value)}
      />
      {row.supplierSource === 'last_purchase' && (
        <div className="reorder-drug-subtext">From last purchase</div>
      )}
    </>
  )
}

export default ReorderCentre
