import { useState, useEffect } from 'react'
import { Plus, Search, Filter, Edit2, Trash2 } from 'lucide-react'
import { getAllDrugs, addDrug, deleteDrug, searchDrugs, calculateDrugStatus } from '../services/drugService'
import { isSupabaseConfigured } from '../lib/supabase'
import { useNotification } from '../context/NotificationContext'
import './Inventory.css'

const Inventory = () => {
  const { notify } = useNotification()
  const [showAddModal, setShowAddModal] = useState(false)
  const [drugs, setDrugs] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [formData, setFormData] = useState({
    name: '',
    batchNumber: '',
    expiryDate: '',
    quantity: '',
    price: '',
    supplier: ''
  })

  // Load drugs on mount
  useEffect(() => {
    loadDrugs()
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
        price: 37
      },
      {
        id: '2',
        name: 'Paracetamol 500mg',
        batch_number: 'BT002',
        expiry_date: '2025-12-20',
        quantity: 4,
        price: 5
      },
      {
        id: '3',
        name: 'Ibuprofen 200mg',
        batch_number: 'BT003',
        expiry_date: '2024-06-30',
        quantity: 15,
        price: 1
      },
      {
        id: '4',
        name: 'Vitamin C 1000mg',
        batch_number: 'BT004',
        expiry_date: '2026-11-10',
        quantity: 1.8,
        price: 1
      }
    ])
    setLoading(false)
  }

  const handleSearch = async (e) => {
    const term = e.target.value
    setSearchTerm(term)
    
    if (!term.trim()) {
      loadDrugs()
      return
    }
    
    try {
      if (isSupabaseConfigured()) {
        const results = await searchDrugs(term)
        setDrugs(results)
      }
    } catch (error) {
      console.error('Error searching:', error)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    
    try {
      if (!isSupabaseConfigured()) {
        notify('Supabase not configured. Please update your .env file.', 'warning')
        return
      }
      
      await addDrug(formData)
      setShowAddModal(false)
      setFormData({
        name: '',
        batchNumber: '',
        expiryDate: '',
        quantity: '',
        price: '',
        supplier: ''
      })
      loadDrugs()
      notify('Drug added successfully!', 'success')
    } catch (error) {
      console.error('Error adding drug:', error)
      notify(`Error adding drug: ${error.message}`, 'error')
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this drug?')) return
    
    try {
      if (!isSupabaseConfigured()) {
        notify('Supabase not configured.', 'warning')
        return
      }
      
      await deleteDrug(id)
      loadDrugs()
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
      expired: { label: 'Expired', class: 'status-expired' }
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
        <button 
          className="btn btn-primary"
          onClick={() => setShowAddModal(true)}
        >
          <Plus size={20} />
          Add Drug
        </button>
      </div>

      {/* Search and Filter */}
      <div className="inventory-controls">
        <div className="search-box">
          <Search size={18} />
          <input 
            type="text" 
            placeholder="Search by name, batch number..."
            value={searchTerm}
            onChange={handleSearch}
          />
        </div>
        <button className="btn btn-outline">
          <Filter size={18} />
          Filter
        </button>
      </div>

      {/* Inventory Table */}
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
            {drugs.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ textAlign: 'center', padding: '2rem' }}>
                  {searchTerm ? 'No drugs found' : 'No drugs in inventory. Click "Add Drug" to get started.'}
                </td>
              </tr>
            ) : (
              drugs.map((drug) => {
                const status = getStatusBadge(drug)
                const total = (drug.quantity * drug.price).toFixed(2)
                const batchNumber = drug.batch_number || drug.batch
                const expiryDate = drug.expiry_date || drug.expiry
                return (
                  <tr key={drug.id}>
                    <td className="drug-name">{drug.name}</td>
                    <td>{batchNumber}</td>
                    <td>{new Date(expiryDate).toLocaleDateString()}</td>
                    <td>{drug.quantity}</td>
                    <td>GHS {drug.price.toFixed(2)}</td>
                    <td className="total-cell">GHS {total}</td>
                    <td>
                      <span className={`status-badge ${status.class}`}>
                        {status.label}
                      </span>
                    </td>
                    <td>
                      <div className="action-buttons">
                        <button className="icon-btn edit-btn" title="Edit">
                          <Edit2 size={16} />
                        </button>
                        <button 
                          className="icon-btn delete-btn" 
                          title="Delete"
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

      {/* Pagination */}
      <div className="pagination">
        <span className="page-info">Showing 1-{drugs.length} of {drugs.length} items</span>
        <div className="page-buttons">
          <button className="page-btn" disabled>1</button>
        </div>
      </div>

      {/* Add Drug Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add New Drug</h2>
              <button 
                className="close-btn"
                onClick={() => setShowAddModal(false)}
              >
                ×
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
                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                  />
                </div>
                <div className="form-group">
                  <label>Batch Number *</label>
                  <input 
                    type="text" 
                    placeholder="e.g., BT001" 
                    required
                    value={formData.batchNumber}
                    onChange={(e) => setFormData({...formData, batchNumber: e.target.value})}
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
                    onChange={(e) => setFormData({...formData, expiryDate: e.target.value})}
                  />
                </div>
                <div className="form-group">
                  <label>Quantity *</label>
                  <input 
                    type="number" 
                    placeholder="0" 
                    required
                    value={formData.quantity}
                    onChange={(e) => setFormData({...formData, quantity: e.target.value})}
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
                    value={formData.price}
                    onChange={(e) => setFormData({...formData, price: e.target.value})}
                  />
                </div>
                <div className="form-group">
                  <label>Supplier</label>
                  <input 
                    type="text" 
                    placeholder="Supplier name"
                    value={formData.supplier}
                    onChange={(e) => setFormData({...formData, supplier: e.target.value})}
                  />
                </div>
              </div>

              <div className="form-actions">
                <button 
                  type="button" 
                  className="btn btn-outline"
                  onClick={() => setShowAddModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Save Drug
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
