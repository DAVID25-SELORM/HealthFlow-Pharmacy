import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Filter, Edit2, Trash2 } from 'lucide-react'
import { getAllDrugs, addDrug, updateDrug, deleteDrug, calculateDrugStatus } from '../services/drugService'
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
  const [showDrugModal, setShowDrugModal] = useState(false)
  const [editingDrugId, setEditingDrugId] = useState(null)
  const [drugs, setDrugs] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [formData, setFormData] = useState(emptyDrugForm)

  useEffect(() => {
    void loadDrugs()
  }, [])

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
        <button className="btn btn-primary" type="button" onClick={openAddModal}>
          <Plus size={20} />
          Add Drug
        </button>
      </div>

      <div className="inventory-controls">
        <div className="search-box">
          <Search size={18} />
          <input
            type="text"
            placeholder="Search by name, batch number..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        </div>
        <div className="filter-box">
          <Filter size={18} />
          <select
            value={activeFilter}
            onChange={(event) => setActiveFilter(event.target.value)}
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
    </div>
  )
}

export default Inventory
