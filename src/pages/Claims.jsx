import { useState, useEffect } from 'react'
import { Plus, FileText, Download, Eye } from 'lucide-react'
import { getAllClaims, createClaim, getClaimsStatistics } from '../services/claimsService'
import { isSupabaseConfigured } from '../lib/supabase'
import './Claims.css'

const Claims = () => {
  const [showNewClaimModal, setShowNewClaimModal] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const [claims, setClaims] = useState([])
  const [stats, setStats] = useState({ total: 0, pending: 0, approved: 0, rejected: 0 })
  const [loading, setLoading] = useState(true)
  const [formData, setFormData] = useState({
    patientName: '',
    insuranceProvider: '',
    insuranceId: '',
    drugs: '',
    totalAmount: '',
    serviceDate: new Date().toISOString().split('T')[0],
    notes: ''
  })

  useEffect(() => {
    loadClaims()
  }, [])

  const loadClaims = async () => {
    try {
      setLoading(true)
      
      if (!isSupabaseConfigured()) {
        console.warn('Supabase not configured, using sample data')
        setSampleData()
        return
      }
      
      const [claimsData, statistics] = await Promise.all([
        getAllClaims(),
        getClaimsStatistics()
      ])
      
      setClaims(claimsData)
      setStats(statistics)
      
    } catch (error) {
      console.error('Error loading claims:', error)
      setSampleData()
    } finally {
      setLoading(false)
    }
  }

  const setSampleData = () => {
    const sampleClaims = [
      {
        id: 'CLM001',
        claim_number: 'CLM001',
        patient_name: 'Adjoa Kwakye',
        insurance_provider: 'NHIS',
        total_amount: 400,
        claim_status: 'approved',
        service_date: '2026-03-28',
        notes: 'Paracetamol, Vitamin C'
      },
      {
        id: 'CLM002',
        claim_number: 'CLM002',
        patient_name: 'Kojo Owusu',
        insurance_provider: 'Glico Health',
        total_amount: 220,
        claim_status: 'pending',
        service_date: '2026-04-01',
        notes: 'Ibuprofen, Amoxicillin'
      },
      {
        id: 'CLM003',
        claim_number: 'CLM003',
        patient_name: 'Yaw Sarpong',
        insurance_provider: 'Enterprise Insurance',
        total_amount: 150,
        claim_status: 'rejected',
        service_date: '2026-03-25',
        notes: 'Vitamin C'
      },
      {
        id: 'CLM004',
        claim_number: 'CLM004',
        patient_name: 'Ama Boateng',
        insurance_provider: 'NHIS',
        total_amount: 380,
        claim_status: 'pending',
        service_date: '2026-04-03',
        notes: 'Paracetamol, Ibuprofen, Multivitamin'
      }
    ]
    setClaims(sampleClaims)
    setStats({ total: 4, pending: 2, approved: 1, rejected: 1 })
    setLoading(false)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    
    try {
      if (!isSupabaseConfigured()) {
        alert('⚠️ Supabase not configured. Please update your .env file.')
        return
      }
      
      await createClaim({
        patientName: formData.patientName,
        insuranceProvider: formData.insuranceProvider,
        insuranceId: formData.insuranceId,
        totalAmount: formData.totalAmount,
        serviceDate: formData.serviceDate,
        notes: formData.drugs + (formData.notes ? '\n\n' + formData.notes : '')
      })
      
      setShowNewClaimModal(false)
      setFormData({
        patientName: '',
        insuranceProvider: '',
        insuranceId: '',
        drugs: '',
        totalAmount: '',
        serviceDate: new Date().toISOString().split('T')[0],
        notes: ''
      })
      loadClaims()
      alert('✅ Claim submitted successfully!')
      
    } catch (error) {
      console.error('Error creating claim:', error)
      alert('❌ Error creating claim: ' + error.message)
    }
  }

  const filterClaims = () => {
    if (activeTab === 'all') return claims
    return claims.filter(claim => claim.claim_status === activeTab)
  }

  const getStatusClass = (status) => {
    const classes = {
      approved: 'status-approved',
      pending: 'status-pending',
      rejected: 'status-rejected'
    }
    return classes[status]
  }

  const getStatusLabel = (status) => {
    return status.charAt(0).toUpperCase() + status.slice(1)
  }

  const filteredClaims = filterClaims()

  if (loading) {
    return (
      <div className="claims-page">
        <div className="page-header">
          <h1>Loading Claims...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="claims-page">
      <div className="page-header">
        <div>
          <h1>Insurance Claims</h1>
          <p>Manage and track insurance claims submissions</p>
        </div>
        <button 
          className="btn btn-primary"
          onClick={() => setShowNewClaimModal(true)}
        >
          <Plus size={20} />
          New Claim
        </button>
      </div>

      {/* Stats Cards */}
      <div className="claims-stats">
        <div className="stat-box">
          <span className="stat-label">Total Claims</span>
          <span className="stat-value">{stats.total}</span>
        </div>
        <div className="stat-box approved">
          <span className="stat-label">Approved</span>
          <span className="stat-value">{stats.approved}</span>
        </div>
        <div className="stat-box pending">
          <span className="stat-label">Pending</span>
          <span className="stat-value">{stats.pending}</span>
        </div>
        <div className="stat-box rejected">
          <span className="stat-label">Rejected</span>
          <span className="stat-value">{stats.rejected}</span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="claims-tabs">
        {['all', 'pending', 'approved', 'rejected'].map(tab => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            <span className="tab-count">
              {tab === 'all' ? stats.total : stats[tab]}
            </span>
          </button>
        ))}
      </div>

      {/* Claims Table */}
      <div className="table-container">
        <table className="claims-table">
          <thead>
            <tr>
              <th>Claim ID</th>
              <th>Patient Name</th>
              <th>Insurance Provider</th>
              <th>Drugs Dispensed</th>
              <th>Amount (GHS)</th>
              <th>Date Submitted</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredClaims.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ textAlign: 'center', padding: '2rem' }}>
                  {activeTab === 'all' ? 'No claims yet. Click "New Claim" to submit one.' : `No ${activeTab} claims`}
                </td>
              </tr>
            ) : (
              filteredClaims.map((claim) => (
                <tr key={claim.id}>
                  <td className="claim-id">{claim.claim_number}</td>
                  <td>{claim.patient_name}</td>
                  <td>{claim.insurance_provider}</td>
                  <td className="drugs-cell">{claim.notes}</td>
                  <td className="amount-cell">GHS {claim.total_amount}</td>
                  <td>{new Date(claim.service_date).toLocaleDateString()}</td>
                  <td>
                    <span className={`status-badge ${getStatusClass(claim.claim_status)}`}>
                      {getStatusLabel(claim.claim_status)}
                    </span>
                  </td>
                  <td>
                    <div className="action-buttons">
                      <button className="icon-btn" title="View Details">
                        <Eye size={16} />
                      </button>
                      <button className="icon-btn" title="Download">
                        <Download size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* New Claim Modal */}
      {showNewClaimModal && (
        <div className="modal-overlay" onClick={() => setShowNewClaimModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Submit New Claim</h2>
              <button 
                className="close-btn"
                onClick={() => setShowNewClaimModal(false)}
              >
                ×
              </button>
            </div>
            <form className="claim-form" onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Patient Name *</label>
                <input 
                  type="text" 
                  placeholder="Enter patient name" 
                  required
                  value={formData.patientName}
                  onChange={(e) => setFormData({...formData, patientName: e.target.value})}
                />
              </div>

              <div className="form-group">
                <label>Insurance Provider *</label>
                <select 
                  required
                  value={formData.insuranceProvider}
                  onChange={(e) => setFormData({...formData, insuranceProvider: e.target.value})}
                >
                  <option value="">Select provider</option>
                  <option value="nhis">NHIS</option>
                  <option value="glico">Glico Health</option>
                  <option value="enterprise">Enterprise Insurance</option>
                  <option value="metropolitan">Metropolitan Health</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="form-group">
                <label>Insurance ID Number *</label>
                <input 
                  type="text" 
                  placeholder="Enter insurance ID" 
                  required
                  value={formData.insuranceId}
                  onChange={(e) => setFormData({...formData, insuranceId: e.target.value})}
                />
              </div>

              <div className="form-group">
                <label>Drugs Dispensed *</label>
                <textarea 
                  rows="3" 
                  placeholder="List all drugs dispensed (one per line)"
                  required
                  value={formData.drugs}
                  onChange={(e) => setFormData({...formData, drugs: e.target.value})}
                ></textarea>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Total Cost (GHS) *</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    placeholder="0.00" 
                    required
                    value={formData.totalAmount}
                    onChange={(e) => setFormData({...formData, totalAmount: e.target.value})}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Service *</label>
                  <input 
                    type="date" 
                    required
                    value={formData.serviceDate}
                    onChange={(e) => setFormData({...formData, serviceDate: e.target.value})}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Prescription Upload (Optional)</label>
                <div className="file-upload">
                  <FileText size={24} />
                  <span>Click to upload or drag prescription</span>
                  <input type="file" accept="image/*,application/pdf" />
                </div>
              </div>

              <div className="form-group">
                <label>Additional Notes</label>
                <textarea 
                  rows="2" 
                  placeholder="Any additional information..."
                  value={formData.notes}
                  onChange={(e) => setFormData({...formData, notes: e.target.value})}
                ></textarea>
              </div>

              <div className="form-actions">
                <button 
                  type="button" 
                  className="btn btn-outline"
                  onClick={() => setShowNewClaimModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Submit Claim
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default Claims
