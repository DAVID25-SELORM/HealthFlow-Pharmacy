import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Package, X, CheckCircle2, XCircle, Eye, Truck } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { formatAppDate } from '../utils/date'
import { PURCHASES_ROLES, hasRole } from '../utils/roles'
import {
  getAllSuppliers,
  createSupplier,
  getAllPurchases,
  createPurchase,
  completePurchase,
  cancelPurchase,
  getPurchasesStats,
} from '../services/purchasesService'
import { getAllDrugs } from '../services/drugService'
import { getBranches } from '../services/branchService'
import './Purchases.css'

const blankPurchaseForm = {
  supplierId:    '',
  supplierName:  '',
  invoiceNumber: '',
  purchaseDate:  new Date().toISOString().split('T')[0],
  notes:         '',
}

const blankItemForm = {
  drugId:          '',
  drugName:        '',
  brandName:       '',
  genericName:     '',
  unit:            'tablet',
  quantity:        '',
  unitCost:        '',
  discountType:    'percent',
  discountAmount:  '0',
  discountPercent: '0',
  saleOnReturn:    false,
  batchNumber:     '',
  expiryDate:      '',
}

const unitOptions = [
  { value: 'tablet', label: 'Tablet' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'vial', label: 'Vial' },
  { value: 'bottle', label: 'Bottle' },
  { value: 'sachet', label: 'Sachet' },
  { value: 'syrup', label: 'Syrup' },
  { value: 'cream', label: 'Cream' },
  { value: 'ointment', label: 'Ointment' },
  { value: 'drops', label: 'Drops' },
  { value: 'injection', label: 'Injection' },
  { value: 'pack', label: 'Pack' },
  { value: 'unit', label: 'Unit' },
]

const STATUS_TABS = ['all', 'draft', 'completed', 'cancelled']

const calcGrossTotal = (qty, cost) => {
  const q = Number.parseFloat(qty) || 0
  const c = Number.parseFloat(cost) || 0
  return q * c
}

const calcDiscountValue = (qty, cost, discountType, discountValue) => {
  const gross = calcGrossTotal(qty, cost)
  const value = Number.parseFloat(discountValue) || 0
  if (discountType === 'amount') {
    return Math.min(Math.max(value, 0), gross)
  }
  return Math.min(Math.max((gross * value) / 100, 0), gross)
}

const calcDiscountPercent = (qty, cost, discountType, discountValue) => {
  const gross = calcGrossTotal(qty, cost)
  if (gross <= 0) return 0
  return (calcDiscountValue(qty, cost, discountType, discountValue) / gross) * 100
}

const calcNetTotal = (qty, cost, discountType, discountValue) => {
  return Math.max(0, calcGrossTotal(qty, cost) - calcDiscountValue(qty, cost, discountType, discountValue))
}

const fmtCurrency = (n) =>
  `GHS ${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const StatusBadge = ({ status }) => (
  <span className={`purchase-badge purchase-badge--${status}`}>{status}</span>
)

const Purchases = () => {
  const { role, profile, branch } = useAuth()
  const { notify } = useNotification()
  const [searchParams, setSearchParams] = useSearchParams()

  const canWrite = hasRole(role, PURCHASES_ROLES)

  // ── data state ──────────────────────────────────────────────
  const [purchases, setPurchases]   = useState([])
  const [suppliers, setSuppliers]   = useState([])
  const [drugs, setDrugs]           = useState([])
  const [stats, setStats]           = useState({ totalThisMonth: 0, totalAllTime: 0, draftCount: 0, completedCount: 0 })
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')

  // ── UI state ────────────────────────────────────────────────
  const [activeTab, setActiveTab]           = useState('all')
  const [searchTerm, setSearchTerm]         = useState('')
  const [showNewModal, setShowNewModal]     = useState(false)
  const [viewPurchase, setViewPurchase]     = useState(null)
  const [submitting, setSubmitting]         = useState(false)
  const [completing, setCompleting]         = useState(null)
  const [cancelling, setCancelling]         = useState(null)
  const [branches, setBranches]             = useState([])
  const [selectedBranchId, setSelectedBranchId] = useState('')

  // ── new purchase form ────────────────────────────────────────
  const [purchaseForm, setPurchaseForm] = useState(blankPurchaseForm)
  const [lineItems, setLineItems]       = useState([])
  const [itemForm, setItemForm]         = useState(blankItemForm)
  const [drugSearch, setDrugSearch]     = useState('')
  const [showNewSupplierInline, setShowNewSupplierInline] = useState(false)
  const [newSupplierName, setNewSupplierName]             = useState('')

  // ── sync tab from URL ────────────────────────────────────────
  useEffect(() => {
    const t = searchParams.get('tab')
    setActiveTab(STATUS_TABS.includes(t) ? t : 'all')
  }, [searchParams])

  const setTab = (tab) => {
    setActiveTab(tab)
    const p = new URLSearchParams(searchParams)
    tab === 'all' ? p.delete('tab') : p.set('tab', tab)
    setSearchParams(p, { replace: true })
  }

  // ── load data ────────────────────────────────────────────────
  const loadAll = async (branchIdOverride = selectedBranchId) => {
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured.')
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      setError('')
      const [purchasesData, suppliersData, drugsData, statsData] = await Promise.all([
        getAllPurchases(),
        getAllSuppliers(),
        getAllDrugs({ useTierAccess: true, branchId: branchIdOverride || undefined }),
        getPurchasesStats(),
      ])
      setPurchases(purchasesData)
      setSuppliers(suppliersData)
      setDrugs(drugsData)
      setStats(statsData)
    } catch (err) {
      setError(err.message || 'Unable to load purchases.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadAll() }, [])

  useEffect(() => {
    let cancelled = false

    const loadBranches = async () => {
      try {
        const rows = await getBranches()
        if (cancelled) return
        const defaultBranchId =
          profile?.branch_id ||
          branch?.id ||
          rows.find((row) => row.is_active !== false && row.is_main)?.id ||
          rows.find((row) => row.is_active !== false)?.id ||
          ''
        setBranches(rows)
        setSelectedBranchId((current) => current || defaultBranchId)
        if (defaultBranchId) {
          await loadAll(defaultBranchId)
        }
      } catch (branchError) {
        console.warn('Unable to load purchase branches:', branchError)
      }
    }

    void loadBranches()
    return () => { cancelled = true }
  }, [branch?.id, profile?.branch_id])

  // ── filtered list ────────────────────────────────────────────
  const filteredPurchases = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return purchases.filter((p) => {
      if (activeTab !== 'all' && p.status !== activeTab) return false
      if (!term) return true
      return (
        (p.purchase_number || '').toLowerCase().includes(term) ||
        (p.supplier_name   || '').toLowerCase().includes(term) ||
        (p.invoice_number  || '').toLowerCase().includes(term)
      )
    })
  }, [purchases, activeTab, searchTerm])

  // ── drug search for item entry ───────────────────────────────
  const filteredDrugs = useMemo(() => {
    const term = drugSearch.trim().toLowerCase()
    if (!term) return drugs.slice(0, 30)
    return drugs
      .filter((d) =>
        d.name.toLowerCase().includes(term) ||
        (d.brand_name || '').toLowerCase().includes(term) ||
        (d.generic_name || '').toLowerCase().includes(term) ||
        (d.batch_number || '').toLowerCase().includes(term)
      )
      .slice(0, 30)
  }, [drugs, drugSearch])

  const selectDrug = (drug) => {
    setItemForm((prev) => ({
      ...prev,
      drugId:   drug.id,
      drugName: drug.name,
      brandName: drug.brand_name || '',
      genericName: drug.generic_name || '',
      unit:     drug.unit || 'tablet',
      unitCost: String(drug.cost_price || drug.price || ''),
      saleOnReturn: Boolean(drug.sale_on_return),
    }))
    setDrugSearch(drug.name)
  }

  // ── add item to line ─────────────────────────────────────────
  const addLineItem = () => {
    const qty  = Number.parseFloat(itemForm.quantity)
    const cost = Number.parseFloat(itemForm.unitCost)
    if (!itemForm.drugName.trim()) { notify('Select a drug first.', 'warning'); return }
    if (!Number.isFinite(qty) || qty <= 0) { notify('Enter a valid quantity.', 'warning'); return }
    if (!Number.isFinite(cost) || cost < 0) { notify('Enter a valid unit cost.', 'warning'); return }

    const discountValue = itemForm.discountType === 'amount'
      ? itemForm.discountAmount
      : itemForm.discountPercent
    const discountAmount = calcDiscountValue(qty, cost, itemForm.discountType, discountValue)
    const discountPercent = calcDiscountPercent(qty, cost, itemForm.discountType, discountValue)
    const netTotal = calcNetTotal(qty, cost, itemForm.discountType, discountValue)

    setLineItems((prev) => [
      ...prev,
      {
        drugId:          itemForm.drugId   || null,
        drugName:        itemForm.drugName.trim(),
        brandName:       itemForm.brandName.trim(),
        genericName:     itemForm.genericName.trim(),
        unit:            itemForm.unit     || 'tablet',
        quantity:        qty,
        unitCost:        cost,
        discountType:    itemForm.discountType,
        discountAmount,
        discountPercent,
        netTotal,
        saleOnReturn:    Boolean(itemForm.saleOnReturn),
        batchNumber:     itemForm.batchNumber.trim() || '',
        expiryDate:      itemForm.expiryDate         || '',
      },
    ])

    setItemForm(blankItemForm)
    setDrugSearch('')
  }

  const removeLineItem = (index) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index))
  }

  const lineTotal = useMemo(
    () => lineItems.reduce((s, i) => s + i.netTotal, 0),
    [lineItems]
  )

  // ── add new supplier inline ──────────────────────────────────
  const handleAddSupplierInline = async () => {
    if (!newSupplierName.trim()) return
    try {
      const supplier = await createSupplier({ name: newSupplierName.trim() })
      setSuppliers((prev) => [supplier, ...prev])
      setPurchaseForm((prev) => ({ ...prev, supplierId: supplier.id, supplierName: supplier.name }))
      setNewSupplierName('')
      setShowNewSupplierInline(false)
      notify(`Supplier "${supplier.name}" added.`, 'success')
    } catch (err) {
      notify(err.message || 'Unable to add supplier.', 'error')
    }
  }

  // ── save purchase ────────────────────────────────────────────
  const handleSavePurchase = async (e) => {
    e.preventDefault()
    if (!lineItems.length) { setError('Add at least one item.'); return }
    try {
      setSubmitting(true)
      setError('')
      await createPurchase({ ...purchaseForm, branchId: selectedBranchId || undefined }, lineItems)
      setShowNewModal(false)
      setPurchaseForm(blankPurchaseForm)
      setLineItems([])
      await loadAll()
      notify('Purchase saved as draft.', 'success')
    } catch (err) {
      setError(err.message || 'Unable to save purchase.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── complete purchase ────────────────────────────────────────
  const handleComplete = async (purchase) => {
    if (!window.confirm(`Complete purchase ${purchase.purchase_number}?\nThis will update drug stock and cannot be undone.`)) return
    try {
      setCompleting(purchase.id)
      await completePurchase(purchase.id)
      await loadAll()
      notify(`${purchase.purchase_number} completed — stock updated.`, 'success')
    } catch (err) {
      notify(err.message || 'Unable to complete purchase.', 'error')
    } finally {
      setCompleting(null)
    }
  }

  // ── cancel purchase ──────────────────────────────────────────
  const handleCancel = async (purchase) => {
    if (!window.confirm(`Cancel purchase ${purchase.purchase_number}?`)) return
    try {
      setCancelling(purchase.id)
      await cancelPurchase(purchase.id)
      await loadAll()
      notify(`${purchase.purchase_number} cancelled.`, 'info')
    } catch (err) {
      notify(err.message || 'Unable to cancel purchase.', 'error')
    } finally {
      setCancelling(null)
    }
  }

  const resetModal = () => {
    setShowNewModal(false)
    setPurchaseForm(blankPurchaseForm)
    setLineItems([])
    setItemForm(blankItemForm)
    setDrugSearch('')
    setError('')
  }

  // ── render ───────────────────────────────────────────────────
  return (
    <div className="purchases-page">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Purchases</h1>
          <p className="page-subtitle">Manage supplier orders and update stock</p>
        </div>
        <div className="header-actions">
          {branches.length > 0 && (
            <label className="purchase-branch-select">
              <span>Branch stock</span>
              <select
                value={selectedBranchId}
                onChange={(event) => {
                  setSelectedBranchId(event.target.value)
                  void loadAll(event.target.value)
                }}
                disabled={Boolean(profile?.branch_id)}
              >
                {branches.filter((row) => row.is_active !== false).map((row) => (
                  <option key={row.id} value={row.id}>{row.name}</option>
                ))}
              </select>
            </label>
          )}
          {canWrite && (
            <button className="btn btn-primary" onClick={() => setShowNewModal(true)}>
              <Plus size={16} /> New Purchase
            </button>
          )}
        </div>
      </div>

      {error && <div className="purchases-alert" role="alert">{error}</div>}

      {/* Stats */}
      <div className="purchases-stats">
        <div className="stat-box">
          <span className="stat-label">Spent This Month</span>
          <span className="stat-value">{fmtCurrency(stats.totalThisMonth)}</span>
        </div>
        <div className="stat-box">
          <span className="stat-label">Total Spent (All Time)</span>
          <span className="stat-value">{fmtCurrency(stats.totalAllTime)}</span>
        </div>
        <div className="stat-box pending">
          <span className="stat-label">Draft Orders</span>
          <span className="stat-value">{stats.draftCount}</span>
        </div>
        <div className="stat-box approved">
          <span className="stat-label">Completed Orders</span>
          <span className="stat-value">{stats.completedCount}</span>
        </div>
      </div>

      {/* Tabs + Search */}
      <div className="purchases-controls">
        <div className="purchases-tabs">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab}
              className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
        <div className="search-box">
          <Search size={16} className="search-icon" />
          <input
            className="search-input"
            placeholder="Search by PO #, supplier, invoice..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      <div className="purchases-table-wrap">
        {loading ? (
          <div className="purchases-loading">Loading purchases...</div>
        ) : filteredPurchases.length === 0 ? (
          <div className="purchases-empty">
            <Package size={40} />
            <p>No purchases found.</p>
            {canWrite && (
              <button className="btn btn-primary" onClick={() => setShowNewModal(true)}>
                <Plus size={16} /> New Purchase
              </button>
            )}
          </div>
        ) : (
          <table className="purchases-table">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Supplier</th>
                <th>Invoice No.</th>
                <th>Date</th>
                <th>Items</th>
                <th>Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPurchases.map((p) => (
                <tr key={p.id}>
                  <td className="po-number">{p.purchase_number}</td>
                  <td>{p.supplier_name || '—'}</td>
                  <td>{p.invoice_number || '—'}</td>
                  <td>{formatAppDate(p.purchase_date)}</td>
                  <td>{p.purchase_items?.length || 0}</td>
                  <td>{fmtCurrency(p.total_amount)}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="purchases-actions">
                    <button
                      className="action-btn action-btn--view"
                      title="View details"
                      onClick={() => setViewPurchase(p)}
                    >
                      <Eye size={14} />
                    </button>
                    {p.status === 'draft' && canWrite && (
                      <>
                        <button
                          className="action-btn action-btn--complete"
                          title="Complete — update stock"
                          disabled={completing === p.id}
                          onClick={() => handleComplete(p)}
                        >
                          <CheckCircle2 size={14} />
                        </button>
                        <button
                          className="action-btn action-btn--cancel"
                          title="Cancel"
                          disabled={cancelling === p.id}
                          onClick={() => handleCancel(p)}
                        >
                          <XCircle size={14} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── NEW PURCHASE MODAL ─────────────────────────────────────────── */}
      {showNewModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && resetModal()}>
          <div className="modal-panel modal-panel--purchase">
            <div className="modal-header">
              <h2>New Purchase Order</h2>
              <button className="modal-close" onClick={resetModal}><X size={18} /></button>
            </div>

            {error && <div className="purchases-alert" role="alert">{error}</div>}

            <div className="purchase-modal-body">
              {/* Left — header + items table */}
              <div className="purchase-modal-left">
                {/* Purchase header */}
                <div className="purchase-header-form">
                  <div className="form-group">
                    <label>Supplier</label>
                    {showNewSupplierInline ? (
                      <div className="inline-supplier">
                        <input
                          className="form-input"
                          placeholder="New supplier name"
                          value={newSupplierName}
                          onChange={(e) => setNewSupplierName(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleAddSupplierInline()}
                        />
                        <button className="btn btn-primary btn-sm" onClick={handleAddSupplierInline}>Add</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setShowNewSupplierInline(false)}>Cancel</button>
                      </div>
                    ) : (
                      <div className="supplier-select-row">
                        <select
                          className="form-input"
                          value={purchaseForm.supplierId}
                          onChange={(e) => {
                            const sup = suppliers.find((s) => s.id === e.target.value)
                            setPurchaseForm((prev) => ({
                              ...prev,
                              supplierId:   e.target.value,
                              supplierName: sup?.name || '',
                            }))
                          }}
                        >
                          <option value="">— Select supplier —</option>
                          {suppliers.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setShowNewSupplierInline(true)}
                        >
                          + New
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label>Invoice No.</label>
                      <input
                        className="form-input"
                        placeholder="INV-0001"
                        value={purchaseForm.invoiceNumber}
                        onChange={(e) => setPurchaseForm((prev) => ({ ...prev, invoiceNumber: e.target.value }))}
                      />
                    </div>
                    <div className="form-group">
                      <label>Purchase Date</label>
                      <input
                        type="date"
                        className="form-input"
                        value={purchaseForm.purchaseDate}
                        onChange={(e) => setPurchaseForm((prev) => ({ ...prev, purchaseDate: e.target.value }))}
                      />
                    </div>
                  </div>
                </div>

                {/* Added items */}
                <div className="purchase-items-section">
                  <table className="purchase-items-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Description</th>
                        <th>Qty</th>
                        <th>Unit</th>
                        <th>U/Cost</th>
                        <th>Discount</th>
                        <th>Net Total</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="empty-row">No items added.</td>
                        </tr>
                      ) : (
                        lineItems.map((item, idx) => (
                          <tr key={idx}>
                            <td>{idx + 1}</td>
                            <td>
                              <div className="item-name">{item.drugName}</div>
                              {item.brandName && <div className="item-meta">Brand: {item.brandName}</div>}
                              {item.genericName && <div className="item-meta">Generic: {item.genericName}</div>}
                              {item.saleOnReturn && <div className="item-meta item-meta--flag">Sale on return</div>}
                              {item.batchNumber && <div className="item-meta">Batch: {item.batchNumber}</div>}
                              {item.expiryDate  && <div className="item-meta">Exp: {item.expiryDate}</div>}
                            </td>
                            <td>{item.quantity}</td>
                            <td>{item.unit}</td>
                            <td>{fmtCurrency(item.unitCost)}</td>
                            <td>
                              {item.discountType === 'amount'
                                ? fmtCurrency(item.discountAmount)
                                : `${Number(item.discountPercent || 0).toFixed(2)}%`}
                            </td>
                            <td>{fmtCurrency(item.netTotal)}</td>
                            <td>
                              <button className="action-btn action-btn--cancel" onClick={() => removeLineItem(idx)}>
                                <X size={12} />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                    {lineItems.length > 0 && (
                      <tfoot>
                        <tr>
                          <td colSpan={6} className="total-label">Total</td>
                          <td className="total-value">{fmtCurrency(lineTotal)}</td>
                          <td></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              {/* Right — item entry panel */}
              <div className="purchase-modal-right">
                <h3 className="entry-panel-title">Enter Purchased Item</h3>

                <div className="form-group">
                  <label>Drug / Item *</label>
                  <div className="drug-search-wrap">
                    <input
                      className="form-input"
                      placeholder="Search by name..."
                      value={drugSearch}
                      onChange={(e) => {
                        setDrugSearch(e.target.value)
                        if (!e.target.value) setItemForm((prev) => ({ ...prev, drugId: '', drugName: '' }))
                      }}
                    />
                    {drugSearch && !itemForm.drugId && filteredDrugs.length > 0 && (
                      <div className="drug-dropdown">
                        {filteredDrugs.map((d) => (
                          <button
                            key={d.id}
                            className="drug-dropdown-item"
                            onClick={() => selectDrug(d)}
                          >
                            <span>
                              <span className="drug-name">{d.name}</span>
                              {(d.brand_name || d.generic_name) && (
                                <span className="drug-meta drug-meta--block">
                                  {[d.brand_name, d.generic_name].filter(Boolean).join(' / ')}
                                </span>
                              )}
                            </span>
                            <span className="drug-meta">{d.unit}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Unit</label>
                    <select
                      className="form-input"
                      value={itemForm.unit}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, unit: e.target.value }))}
                    >
                      {unitOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Qty *</label>
                    <input
                      type="number"
                      className="form-input"
                      min="0"
                      value={itemForm.quantity}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, quantity: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Brand Name</label>
                    <input
                      className="form-input"
                      placeholder="e.g. Panadol"
                      value={itemForm.brandName}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, brandName: e.target.value }))}
                    />
                  </div>
                  <div className="form-group">
                    <label>Generic Name</label>
                    <input
                      className="form-input"
                      placeholder="e.g. Paracetamol"
                      value={itemForm.genericName}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, genericName: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Unit Cost (GHS)</label>
                    <input
                      type="number"
                      className="form-input"
                      min="0"
                      step="0.01"
                      value={itemForm.unitCost}
                      onChange={(e) => setItemForm((prev) => ({ ...prev, unitCost: e.target.value }))}
                    />
                  </div>
                  <div className="form-group">
                    <label>{itemForm.discountType === 'amount' ? 'Discount Value (GHS)' : 'Discount Value (%)'}</label>
                    <div className="discount-input-row">
                      <select
                        className="form-input"
                        value={itemForm.discountType}
                        onChange={(e) => setItemForm((prev) => ({ ...prev, discountType: e.target.value }))}
                      >
                        <option value="percent">%</option>
                        <option value="amount">GHS</option>
                      </select>
                      <input
                        type="number"
                        className="form-input"
                        min="0"
                        max={itemForm.discountType === 'percent' ? '100' : undefined}
                        step="0.01"
                        placeholder={itemForm.discountType === 'amount' ? 'Amount' : 'Percent'}
                        aria-label={itemForm.discountType === 'amount' ? 'Discount amount in Ghana cedis' : 'Discount percentage'}
                        value={itemForm.discountType === 'amount' ? itemForm.discountAmount : itemForm.discountPercent}
                        onChange={(e) =>
                          setItemForm((prev) => ({
                            ...prev,
                            [prev.discountType === 'amount' ? 'discountAmount' : 'discountPercent']: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>

                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={itemForm.saleOnReturn}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, saleOnReturn: e.target.checked }))}
                  />
                  <span>Sale on return</span>
                </label>

                <div className="form-group net-total-display">
                  <label>Net Total</label>
                  <span>
                    {fmtCurrency(
                      calcNetTotal(
                        itemForm.quantity,
                        itemForm.unitCost,
                        itemForm.discountType,
                        itemForm.discountType === 'amount'
                          ? itemForm.discountAmount
                          : itemForm.discountPercent
                      )
                    )}
                  </span>
                </div>

                <div className="form-group">
                  <label>Batch No.</label>
                  <input
                    className="form-input"
                    value={itemForm.batchNumber}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, batchNumber: e.target.value }))}
                  />
                </div>

                <div className="form-group">
                  <label>Expiry Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={itemForm.expiryDate}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, expiryDate: e.target.value }))}
                  />
                </div>

                <div className="entry-panel-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => { setItemForm(blankItemForm); setDrugSearch('') }}
                  >
                    Clear
                  </button>
                  <button type="button" className="btn btn-primary" onClick={addLineItem}>
                    + Add
                  </button>
                </div>
              </div>
            </div>

            {/* Modal footer */}
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={resetModal}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={submitting || !lineItems.length}
                onClick={handleSavePurchase}
              >
                {submitting ? 'Saving...' : 'Save Draft'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── VIEW PURCHASE MODAL ────────────────────────────────────────── */}
      {viewPurchase && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setViewPurchase(null)}>
          <div className="modal-panel modal-panel--view">
            <div className="modal-header">
              <h2>
                {viewPurchase.purchase_number}
                <StatusBadge status={viewPurchase.status} />
              </h2>
              <button className="modal-close" onClick={() => setViewPurchase(null)}><X size={18} /></button>
            </div>
            <div className="view-purchase-meta">
              <div><strong>Supplier:</strong> {viewPurchase.supplier_name || '—'}</div>
              <div><strong>Invoice:</strong>  {viewPurchase.invoice_number || '—'}</div>
              <div><strong>Date:</strong>     {formatAppDate(viewPurchase.purchase_date)}</div>
              {viewPurchase.notes && <div><strong>Notes:</strong> {viewPurchase.notes}</div>}
            </div>
            <table className="purchases-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Drug / Item</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Unit Cost</th>
                  <th>Discount</th>
                  <th>Net Total</th>
                  <th>Batch</th>
                  <th>Expiry</th>
                </tr>
              </thead>
              <tbody>
                {(viewPurchase.purchase_items || []).map((item, idx) => (
                  <tr key={item.id}>
                    <td>{idx + 1}</td>
                    <td>
                      <div className="item-name">{item.drug_name}</div>
                      {item.brand_name && <div className="item-meta">Brand: {item.brand_name}</div>}
                      {item.generic_name && <div className="item-meta">Generic: {item.generic_name}</div>}
                      {item.sale_on_return && <div className="item-meta item-meta--flag">Sale on return</div>}
                    </td>
                    <td>{item.quantity}</td>
                    <td>{item.unit}</td>
                    <td>{fmtCurrency(item.unit_cost)}</td>
                    <td>{Number(item.discount_percent || 0).toFixed(2)}%</td>
                    <td>{fmtCurrency(item.net_total)}</td>
                    <td>{item.batch_number || '—'}</td>
                    <td>{item.expiry_date ? formatAppDate(item.expiry_date) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6} className="total-label">Total</td>
                  <td colSpan={3} className="total-value">{fmtCurrency(viewPurchase.total_amount)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="modal-footer">
              {viewPurchase.status === 'draft' && canWrite && (
                <>
                  <button
                    className="btn btn-primary"
                    disabled={completing === viewPurchase.id}
                    onClick={async () => {
                      await handleComplete(viewPurchase)
                      setViewPurchase(null)
                    }}
                  >
                    <CheckCircle2 size={14} /> Complete &amp; Update Stock
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={cancelling === viewPurchase.id}
                    onClick={async () => {
                      await handleCancel(viewPurchase)
                      setViewPurchase(null)
                    }}
                  >
                    Cancel Order
                  </button>
                </>
              )}
              <button className="btn btn-secondary" onClick={() => setViewPurchase(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Purchases
