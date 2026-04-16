import { useEffect, useState } from 'react'
import { Building2, Plus, Users, CheckCircle, PauseCircle, XCircle, ChevronDown, ChevronUp, Eye } from 'lucide-react'
import { useNotification } from '../context/NotificationContext'
import {
  getAllOrganizations,
  getOrganizationUserCounts,
  createPharmacyTenant,
  updateOrganizationStatus,
  updateSubscriptionTier,
  getOrganizationUsers,
  checkSubdomainAvailable,
} from '../services/tenantAdminService'
import './TenantAdmin.css'

const STATUS_ICONS = {
  trial: <PauseCircle size={14} />,
  active: <CheckCircle size={14} />,
  suspended: <XCircle size={14} />,
  inactive: <XCircle size={14} />,
}

const blankPharmacy = {
  name: '',
  subdomain: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  region: '',
  licenseNumber: '',
  subscriptionTier: 'basic',
}

const blankAdmin = {
  fullName: '',
  email: '',
  phone: '',
  temporaryPassword: '',
}

const TenantAdmin = () => {
  const { notify } = useNotification()

  const [orgs, setOrgs] = useState([])
  const [userCounts, setUserCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [pharmacy, setPharmacy] = useState(blankPharmacy)
  const [admin, setAdmin] = useState(blankAdmin)
  const [creating, setCreating] = useState(false)
  const [subdomainOk, setSubdomainOk] = useState(null)
  const [checkingSubdomain, setCheckingSubdomain] = useState(false)

  // Expanded org detail
  const [expandedOrgId, setExpandedOrgId] = useState(null)
  const [orgUsers, setOrgUsers] = useState({})

  useEffect(() => {
    void load()
  }, [])

  const load = async () => {
    try {
      setLoading(true)
      setError('')
      const data = await getAllOrganizations()
      setOrgs(data)
      const ids = data.map((o) => o.id)
      const counts = await getOrganizationUserCounts(ids)
      setUserCounts(counts)
    } catch (err) {
      setError(err.message || 'Failed to load organizations')
    } finally {
      setLoading(false)
    }
  }

  const handleSubdomainBlur = async () => {
    const val = pharmacy.subdomain.trim()
    if (val.length < 3) {
      setSubdomainOk(null)
      return
    }
    setCheckingSubdomain(true)
    try {
      const available = await checkSubdomainAvailable(val)
      setSubdomainOk(available)
    } catch {
      setSubdomainOk(null)
    } finally {
      setCheckingSubdomain(false)
    }
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!pharmacy.name.trim()) return setError('Pharmacy name is required')
    if (!pharmacy.subdomain.trim() || pharmacy.subdomain.length < 3) return setError('Subdomain must be at least 3 characters')
    if (subdomainOk === false) return setError('That subdomain is already taken')
    if (!admin.email.trim()) return setError('Admin email is required')
    if (!admin.temporaryPassword || admin.temporaryPassword.length < 8) return setError('Temporary password must be at least 8 characters')
    if (!admin.fullName.trim()) return setError('Admin full name is required')

    setCreating(true)
    setError('')
    try {
      await createPharmacyTenant({ pharmacy, admin })
      notify(`Pharmacy "${pharmacy.name}" created successfully!`, 'success', 5000)
      setPharmacy(blankPharmacy)
      setAdmin(blankAdmin)
      setSubdomainOk(null)
      setShowCreate(false)
      await load()
    } catch (err) {
      setError(err.message || 'Failed to create pharmacy')
    } finally {
      setCreating(false)
    }
  }

  const handleStatusChange = async (orgId, newStatus) => {
    try {
      await updateOrganizationStatus(orgId, newStatus)
      notify('Status updated', 'success')
      await load()
    } catch (err) {
      setError(err.message || 'Failed to update status')
    }
  }

  const handleTierChange = async (orgId, tier) => {
    try {
      await updateSubscriptionTier(orgId, tier)
      notify('Subscription tier updated', 'success')
      await load()
    } catch (err) {
      setError(err.message || 'Failed to update tier')
    }
  }

  const toggleExpand = async (orgId) => {
    if (expandedOrgId === orgId) {
      setExpandedOrgId(null)
      return
    }
    setExpandedOrgId(orgId)
    if (!orgUsers[orgId]) {
      try {
        const users = await getOrganizationUsers(orgId)
        setOrgUsers((prev) => ({ ...prev, [orgId]: users }))
      } catch {
        // silently fail
      }
    }
  }

  if (loading) {
    return (
      <div className="tenant-admin-page">
        <div className="page-header">
          <h1>Loading tenants...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="tenant-admin-page">
      <div className="page-header">
        <div>
          <h1>Tenant Administration</h1>
          <p>Manage all pharmacy organizations on the platform</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={16} />
          {showCreate ? 'Cancel' : 'Add Pharmacy'}
        </button>
      </div>

      {error && <div className="tenant-alert">{error}</div>}

      {/* Create Form */}
      {showCreate && (
        <div className="tenant-create-card">
          <h3>Register New Pharmacy</h3>
          <form onSubmit={handleCreate}>
            <div className="tenant-form-section">
              <h4>Pharmacy Details</h4>
              <div className="tenant-form-grid">
                <div className="tenant-form-group">
                  <label>Pharmacy Name *</label>
                  <input
                    placeholder="ABC Pharmacy"
                    value={pharmacy.name}
                    onChange={(e) => setPharmacy({ ...pharmacy, name: e.target.value })}
                    required
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Subdomain *</label>
                  <div className="subdomain-row">
                    <input
                      placeholder="abc-pharmacy"
                      value={pharmacy.subdomain}
                      onChange={(e) => {
                        setPharmacy({ ...pharmacy, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })
                        setSubdomainOk(null)
                      }}
                      onBlur={handleSubdomainBlur}
                      required
                    />
                    <span className="subdomain-suffix">.healthflow.app</span>
                  </div>
                  {checkingSubdomain && <p className="field-hint">Checking...</p>}
                  {subdomainOk === true && <p className="field-hint available">✓ Available</p>}
                  {subdomainOk === false && <p className="field-hint taken">✗ Already taken</p>}
                </div>
                <div className="tenant-form-group">
                  <label>Phone</label>
                  <input
                    placeholder="+233 123 456 789"
                    value={pharmacy.phone}
                    onChange={(e) => setPharmacy({ ...pharmacy, phone: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    placeholder="info@pharmacy.com"
                    value={pharmacy.email}
                    onChange={(e) => setPharmacy({ ...pharmacy, email: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group full-width">
                  <label>Address</label>
                  <input
                    placeholder="123 Main Street"
                    value={pharmacy.address}
                    onChange={(e) => setPharmacy({ ...pharmacy, address: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group">
                  <label>City</label>
                  <input
                    placeholder="Accra"
                    value={pharmacy.city}
                    onChange={(e) => setPharmacy({ ...pharmacy, city: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Region</label>
                  <input
                    placeholder="Greater Accra"
                    value={pharmacy.region}
                    onChange={(e) => setPharmacy({ ...pharmacy, region: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group">
                  <label>License Number</label>
                  <input
                    placeholder="PL-12345"
                    value={pharmacy.licenseNumber}
                    onChange={(e) => setPharmacy({ ...pharmacy, licenseNumber: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Subscription Tier</label>
                  <select
                    value={pharmacy.subscriptionTier}
                    onChange={(e) => setPharmacy({ ...pharmacy, subscriptionTier: e.target.value })}
                  >
                    <option value="basic">Basic</option>
                    <option value="standard">Standard</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="tenant-form-section">
              <h4>Admin Account</h4>
              <div className="tenant-form-grid">
                <div className="tenant-form-group">
                  <label>Full Name *</label>
                  <input
                    placeholder="John Doe"
                    value={admin.fullName}
                    onChange={(e) => setAdmin({ ...admin, fullName: e.target.value })}
                    required
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Email *</label>
                  <input
                    type="email"
                    placeholder="admin@pharmacy.com"
                    value={admin.email}
                    onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
                    required
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Phone</label>
                  <input
                    placeholder="+233 123 456 789"
                    value={admin.phone}
                    onChange={(e) => setAdmin({ ...admin, phone: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Temporary Password *</label>
                  <input
                    type="password"
                    minLength={8}
                    placeholder="Min 8 characters"
                    value={admin.temporaryPassword}
                    onChange={(e) => setAdmin({ ...admin, temporaryPassword: e.target.value })}
                    required
                  />
                </div>
              </div>
              <p className="tenant-helper">Share the temporary password securely. The admin should change it on first login.</p>
            </div>

            <div className="tenant-form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating...' : 'Create Pharmacy'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Organizations Table */}
      <div className="tenant-table-card">
        <div className="tenant-table-header">
          <h3>
            <Building2 size={18} />
            All Pharmacies ({orgs.length})
          </h3>
        </div>

        {orgs.length === 0 ? (
          <div className="tenant-empty">No pharmacies registered yet.</div>
        ) : (
          <div className="tenant-table-wrap">
            <table className="tenant-table">
              <thead>
                <tr>
                  <th>Pharmacy</th>
                  <th>Subdomain</th>
                  <th>Status</th>
                  <th>Tier</th>
                  <th>Users</th>
                  <th>Registered</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <>
                    <tr key={org.id} className={expandedOrgId === org.id ? 'expanded' : ''}>
                      <td>
                        <div className="org-name-cell">
                          <strong>{org.name}</strong>
                          {org.email && <span className="org-email">{org.email}</span>}
                        </div>
                      </td>
                      <td>
                        <code className="subdomain-chip">{org.subdomain}</code>
                      </td>
                      <td>
                        <select
                          className={`status-select status-${org.status}`}
                          value={org.status}
                          onChange={(e) => handleStatusChange(org.id, e.target.value)}
                        >
                          <option value="trial">Trial</option>
                          <option value="active">Active</option>
                          <option value="suspended">Suspended</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      </td>
                      <td>
                        <select
                          className="tier-select"
                          value={org.subscription_tier}
                          onChange={(e) => handleTierChange(org.id, e.target.value)}
                        >
                          <option value="basic">Basic</option>
                          <option value="standard">Standard</option>
                          <option value="enterprise">Enterprise</option>
                        </select>
                      </td>
                      <td>
                        <span className="user-count">
                          <Users size={13} />
                          {userCounts[org.id] || 0}
                        </span>
                      </td>
                      <td>
                        <span className="date-cell">
                          {new Date(org.created_at).toLocaleDateString()}
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn-icon"
                          title="View users"
                          onClick={() => toggleExpand(org.id)}
                        >
                          <Eye size={15} />
                          {expandedOrgId === org.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                      </td>
                    </tr>

                    {/* Expanded users row */}
                    {expandedOrgId === org.id && (
                      <tr key={`${org.id}-users`} className="users-expand-row">
                        <td colSpan={7}>
                          <div className="users-expand">
                            <h5>Users in {org.name}</h5>
                            {orgUsers[org.id] ? (
                              orgUsers[org.id].length === 0 ? (
                                <p className="no-users">No users yet.</p>
                              ) : (
                                <table className="users-inner-table">
                                  <thead>
                                    <tr>
                                      <th>Name</th>
                                      <th>Email</th>
                                      <th>Role</th>
                                      <th>Status</th>
                                      <th>Joined</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {orgUsers[org.id].map((u) => (
                                      <tr key={u.id}>
                                        <td>{u.full_name}</td>
                                        <td>{u.email}</td>
                                        <td><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
                                        <td>
                                          <span className={`active-badge ${u.is_active ? 'active' : 'inactive'}`}>
                                            {u.is_active ? 'Active' : 'Inactive'}
                                          </span>
                                        </td>
                                        <td>{new Date(u.created_at).toLocaleDateString()}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )
                            ) : (
                              <p className="no-users">Loading...</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default TenantAdmin
