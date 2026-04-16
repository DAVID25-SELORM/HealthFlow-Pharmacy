import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Filter, Edit2, Trash2, Upload, Download } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { dispatchHealthflowDataChanged } from '../lib/appEvents'
import { getAllDrugs, addDrug, updateDrug, deleteDrug, calculateDrugStatus } from '../services/drugService'
import { parseExcelFile, validateImportData, importDrugs, generateTemplate } from '../services/drugImportService'
import { isSupabaseConfigured } from '../lib/supabase'
import { useNotification } from '../context/NotificationContext'
import './Inventory.css'

const emptyDrugForm = {
  name: '',
  batchNumber: '',
  expiryDate: '',
  quantity: '',
  price: '',
  supplier: '',
}

const filterOptions = [
  { value: 'all', label: 'All Medicines' },
  { value: 'good', label: 'Good Stock' },
  { value: 'low', label: 'Low Stock' },
  { value: 'expiring', label: 'Expiring Soon' },
  { value: 'expired', label: 'Expired' },
]

const mapDrugToForm = (drug) => ({
  name: drug.name || '',
  batchNumber: drug.batch_number || drug.batch || '',
  expiryDate: drug.expiry_date || drug.expiry || '',
  quantity: String(drug.quantity ?? ''),
  price: String(drug.price ?? ''),
  supplier: drug.supplier || '',
})

const Inventory = () => {
  const { notify } = useNotification()
  const [searchParams, setSearchParams] = useSearchParams()
  const [showDrugModal, setShowDrugModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [editingDrugId, setEditingDrugId] = useState(null)
  const [drugs, setDrugs] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [formData, setFormData] = useState(emptyDrugForm)
  const [importFile, setImportFile] = useState(null)
  const [importPreview, setImportPreview] = useState(null)

  useEffect(() => {
    void loadDrugs()
  }, [])

  useEffect(() => {
    const routeSearch = searchParams.get('search') || ''
    const routeFilter = searchParams.get('filter')
    const validRouteFilter = filterOptions.some((option) => option.value === routeFilter)
      ? routeFilter
      : 'all'

    setSearchTerm((current) => (current === routeSearch ? current : routeSearch))
    setActiveFilter((current) => (current === validRouteFilter ? current : validRouteFilter))
  }, [searchParams])

  const updateQueryParams = (nextSearch, nextFilter) => {
    const params = new URLSearchParams(searchParams)

    if (nextSearch) {
      params.set('search', nextSearch)
    } else {
      params.delete('search')
    }

    if (nextFilter && nextFilter !== 'all') {
      params.set('filter', nextFilter)
    } else {
      params.delete('filter')
    }

    setSearchParams(params, { replace: true })
  }

  const loadDrugs = async () => {
    try {
      setLoading(true)
      if (!isSupabaseConfigured()) {
        console.warn('Supabase not configured, using sample data')
        setSampleData()
        return
      }

      const data = await getAllDrugs()
      setDrugs(data)
    } catch (error) {
      console.error('Error loading drugs:', error)
      setSampleData()
    } finally {
      setLoading(false)
    }
  }

  const setSampleData = () => {
    setDrugs([
      {
        id: '1',
        name: 'Amoxicillin 500mg',
        batch_number: 'BT001',
        expiry_date: '2026-08-15',
        quantity: 12,
        price: 37,
      },
      {
        id: '2',
        name: 'Paracetamol 500mg',
        batch_number: 'BT002',
        expiry_date: '2025-12-20',
        quantity: 4,
        price: 5,
      },
      {
        id: '3',
        name: 'Ibuprofen 200mg',
        batch_number: 'BT003',
        expiry_date: '2024-06-30',
        quantity: 15,
        price: 1,
      },
      {
        id: '4',
        name: 'Vitamin C 1000mg',
        batch_number: 'BT004',
        expiry_date: '2026-11-10',
        quantity: 1.8,
        price: 1,
      },
    ])
    setLoading(false)
  }

  const visibleDrugs = useMemo(() => {
    const normalizedTerm = searchTerm.trim().toLowerCase()

    return drugs.filter((drug) => {
      const name = String(drug.name || '').toLowerCase()
      const batchNumber = String(drug.batch_number || drug.batch || '').toLowerCase()
      const matchesSearch =
        !normalizedTerm || name.includes(normalizedTerm) || batchNumber.includes(normalizedTerm)
      const matchesFilter =
        activeFilter === 'all' || calculateDrugStatus(drug) === activeFilter

      return matchesSearch && matchesFilter
    })
  }, [activeFilter, drugs, searchTerm])

  const resetForm = () => {
    setEditingDrugId(null)
    setFormData(emptyDrugForm)
  }

  const closeDrugModal = () => {
    setShowDrugModal(false)
    resetForm()
  }

  const openAddModal = () => {
    resetForm()
    setShowDrugModal(true)
  }

  const openEditModal = (drug) => {
    setEditingDrugId(drug.id)
    setFormData(mapDrugToForm(drug))
    setShowDrugModal(true)
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    try {
      setSubmitting(true)

      if (!isSupabaseConfigured()) {
        notify('Supabase not configured. Please update your .env file.', 'warning')
        return
      }

      if (editingDrugId) {
        await updateDrug(editingDrugId, formData)
        notify('Medicine updated successfully!', 'success')
      } else {
        await addDrug(formData)
        notify('Drug added successfully!', 'success')
      }

      closeDrugModal()
      await loadDrugs()
      dispatchHealthflowDataChanged()
    } catch (error) {
      console.error('Error saving drug:', error)
      notify(`Error saving drug: ${error.message}`, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this drug?')) {
      return
    }

    try {
      if (!isSupabaseConfigured()) {
        notify('Supabase not configured.', 'warning')
        return
      }

      await deleteDrug(id)
      await loadDrugs()
      dispatchHealthflowDataChanged()
      notify('Drug deleted successfully!', 'success')
    } catch (error) {
      console.error('Error deleting drug:', error)
      notify(`Error deleting drug: ${error.message}`, 'error')
    }
  }

  const getStatusBadge = (drug) => {
    const status = calculateDrugStatus(drug)
    const statusConfig = {
      good: { label: 'Good Stock', class: 'status-good' },
      low: { label: 'Low Stock', class: 'status-low' },
      expiring: { label: 'Expiring Soon', class: 'status-expiring' },
      expired: { label: 'Expired', class: 'status-expired' },
    }

    return statusConfig[status] || statusConfig.good
  }

  const handleDownloadTemplate = () => {
    try {
      generateTemplate()
      notify('Template downloaded successfully!', 'success')
    } catch (error) {
      notify(`Error downloading template: ${error.message}`, 'error')
    }
  }

  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
      notify('Please select an Excel file (.xlsx or .xls)', 'error')
      return
    }

    try {
      setImporting(true)
      const data = await parseExcelFile(file)
      const validation = validateImportData(data)

      setImportFile(file)
      setImportPreview(validation)
      setShowImportModal(true)
    } catch (error) {
      notify(`Error reading file: ${error.message}`, 'error')
    } finally {
      setImporting(false)
      // Reset file input
      event.target.value = ''
    }
  }

  const handleImport = async () => {
    if (!importPreview || importPreview.validCount === 0) {
      notify('No valid drugs to import', 'warning')
      return
    }

    if (!isSupabaseConfigured()) {
      notify('Supabase not configured. Please update your .env file.', 'warning')
      return
    }

    try {
      setImporting(true)
      const results = await importDrugs(importPreview.validRows)

      if (results.successful.length > 0) {
        notify(
          `Successfully imported ${results.successful.length} drug(s)!`,
          'success'
        )
      }

      if (results.failed.length > 0) {
        notify(
          `Failed to import ${results.failed.length} drug(s). Check for duplicates.`,
          'warning',
          5000
        )
      }

      setShowImportModal(false)
      setImportFile(null)
      setImportPreview(null)
      await loadDrugs()
      dispatchHealthflowDataChanged()
    } catch (error) {
      notify(`Import error: ${error.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  const closeImportModal = () => {
    setShowImportModal(false)
    setImportFile(null)
    setImportPreview(null)
  }

  const handleSearchChange = (value) => {
    setSearchTerm(value)
    updateQueryParams(value.trim(), activeFilter)
  }

  const handleFilterChange = (value) => {
    setActiveFilter(value)
    updateQueryParams(searchTerm.trim(), value)
  }

  if (loading) {
    return (
      <div className="inventory-page">
        <div className="page-header">
          <h1>Loading...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="inventory-page">
      <div className="page-header">
        <div>
          <h1>Inventory Management</h1>
          <p>Manage your drug stock, track expiry dates, and monitor low stock items</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" type="button" onClick={handleDownloadTemplate}>
            <Download size={20} />
            Download Template
          </button>
          <label className="btn btn-secondary">
            <Upload size={20} />
            Import Excel
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
              disabled={importing}
            />
          </label>
          <button className="btn btn-primary" type="button" onClick={openAddModal}>
            <Plus size={20} />
            Add Drug
          </button>
        </div>
      </div>

      <div className="inventory-controls">
        <div className="search-box">
          <Search size={18} />
            <input
              type="text"
              placeholder="Search by name, batch number..."
              value={searchTerm}
              onChange={(event) => handleSearchChange(event.target.value)}
            />
        </div>
        <div className="filter-box">
          <Filter size={18} />
            <select
              value={activeFilter}
              onChange={(event) => handleFilterChange(event.target.value)}
              aria-label="Filter medicines"
            >
            {filterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="table-container">
        <table className="inventory-table">
          <thead>
            <tr>
              <th>Drug Name</th>
              <th>Batch Number</th>
              <th>Expiry Date</th>
              <th>Quantity</th>
              <th>Price (GHS)</th>
              <th>Total (GHS)</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleDrugs.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ textAlign: 'center', padding: '2rem' }}>
                  {searchTerm || activeFilter !== 'all'
                    ? 'No medicines match the current search or filter.'
                    : 'No drugs in inventory. Click "Add Drug" to get started.'}
                </td>
              </tr>
            ) : (
              visibleDrugs.map((drug) => {
                const status = getStatusBadge(drug)
                const quantity = Number.parseFloat(drug.quantity ?? 0) || 0
                const price = Number.parseFloat(drug.price ?? 0) || 0
                const total = (quantity * price).toFixed(2)
                const batchNumber = drug.batch_number || drug.batch || 'N/A'
                const expiryDate = drug.expiry_date || drug.expiry

                return (
                  <tr key={drug.id}>
                    <td className="drug-name">{drug.name}</td>
                    <td>{batchNumber}</td>
                    <td>{expiryDate ? new Date(expiryDate).toLocaleDateString() : 'N/A'}</td>
                    <td>{quantity}</td>
                    <td>GHS {price.toFixed(2)}</td>
                    <td className="total-cell">GHS {total}</td>
                    <td>
                      <span className={`status-badge ${status.class}`}>{status.label}</span>
                    </td>
                    <td>
                      <div className="action-buttons">
                        <button
                          className="icon-btn edit-btn"
                          title={`Edit ${drug.name}`}
                          type="button"
                          onClick={() => openEditModal(drug)}
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          className="icon-btn delete-btn"
                          title={`Delete ${drug.name}`}
                          type="button"
                          onClick={() => handleDelete(drug.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span className="page-info">
          Showing {visibleDrugs.length === 0 ? 0 : 1}-{visibleDrugs.length} of {drugs.length} items
        </span>
        <div className="page-buttons">
          <button className="page-btn" disabled>
            1
          </button>
        </div>
      </div>

      {showDrugModal && (
        <div className="modal-overlay" onClick={closeDrugModal}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingDrugId ? 'Edit Medicine' : 'Add New Drug'}</h2>
              <button className="close-btn" type="button" onClick={closeDrugModal}>
                x
              </button>
            </div>
            <form className="drug-form" onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Drug Name *</label>
                  <input
                    type="text"
                    placeholder="e.g., Paracetamol 500mg"
                    required
                    value={formData.name}
                    onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Batch Number *</label>
                  <input
                    type="text"
                    placeholder="e.g., BT001"
                    required
                    value={formData.batchNumber}
                    onChange={(event) => setFormData({ ...formData, batchNumber: event.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Expiry Date *</label>
                  <input
                    type="date"
                    required
                    value={formData.expiryDate}
                    onChange={(event) => setFormData({ ...formData, expiryDate: event.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Quantity *</label>
                  <input
                    type="number"
                    placeholder="0"
                    required
                    min="0"
                    value={formData.quantity}
                    onChange={(event) => setFormData({ ...formData, quantity: event.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Price (GHS) *</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    required
                    min="0"
                    value={formData.price}
                    onChange={(event) => setFormData({ ...formData, price: event.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Supplier</label>
                  <input
                    type="text"
                    placeholder="Supplier name"
                    value={formData.supplier}
                    onChange={(event) => setFormData({ ...formData, supplier: event.target.value })}
                  />
                </div>
              </div>

              <div className="form-actions">
                <button type="button" className="btn btn-outline" onClick={closeDrugModal}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Saving...' : editingDrugId ? 'Update Medicine' : 'Save Drug'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImportModal && importPreview && (
        <div className="modal-overlay" onClick={closeImportModal}>
          <div className="modal-content import-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Import Drugs from Excel</h2>
              <button className="close-btn" type="button" onClick={closeImportModal}>
                x
              </button>
            </div>
            
            <div className="import-preview">
              <div className="import-stats">
                <div className="stat-card success">
                  <h3>{importPreview.validCount}</h3>
                  <p>Valid Rows</p>
                </div>
                <div className="stat-card danger">
                  <h3>{importPreview.invalidCount}</h3>
                  <p>Invalid Rows</p>
                </div>
                <div className="stat-card">
                  <h3>{importPreview.totalRows}</h3>
                  <p>Total Rows</p>
                </div>
              </div>

              {importPreview.invalidCount > 0 && (
                <div className="import-errors">
                  <h4>Import Errors</h4>
                  <div className="error-list">
                    {importPreview.invalidRows.slice(0, 5).map((invalid, idx) => (
                      <div key={idx} className="error-item">
                        <strong>Row {invalid.row}:</strong>
                        <ul>
                          {invalid.errors.map((err, errIdx) => (
                            <li key={errIdx}>{err}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {importPreview.invalidCount > 5 && (
                      <p className="more-errors">
                        ...and {importPreview.invalidCount - 5} more error(s). 
                        Invalid rows will be skipped.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {importPreview.validCount > 0 && (
                <div className="valid-preview">
                  <h4>Valid Drugs to Import</h4>
                  <div className="preview-table-wrapper">
                    <table className="preview-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Batch</th>
                          <th>Expiry</th>
                          <th>Qty</th>
                          <th>Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importPreview.validRows.slice(0, 5).map((drug, idx) => (
                          <tr key={idx}>
                            <td>{drug.name}</td>
                            <td>{drug.batch_number}</td>
                            <td>{drug.expiry_date}</td>
                            <td>{drug.quantity}</td>
                            <td>GHS {drug.price}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {importPreview.validCount > 5 && (
                      <p className="more-rows">
                        ...and {importPreview.validCount - 5} more drug(s)
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="form-actions">
              <button 
                type="button" 
                className="btn btn-outline" 
                onClick={closeImportModal}
                disabled={importing}
              >
                Cancel
              </button>
              <button 
                type="button" 
                className="btn btn-primary" 
                onClick={handleImport}
                disabled={importing || importPreview.validCount === 0}
              >
                {importing ? 'Importing...' : `Import ${importPreview.validCount} Drug(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Inventory
