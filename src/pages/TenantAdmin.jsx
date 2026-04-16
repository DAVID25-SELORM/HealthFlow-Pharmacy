import { Fragment, useEffect, useState } from 'react'
import { Building2, GitBranch, Plus, Users, ChevronDown, ChevronUp, Eye, Pencil } from 'lucide-react'
import { useNotification } from '../context/NotificationContext'
import {
  getAllOrganizations,
  getOrganizationUserCounts,
  createPharmacyTenant,
  updateOrganizationStatus,
  updateSubscriptionTier,
  updateOrganizationDetails,
  updateOrganizationUser,
  getOrganizationUsers,
  checkSubdomainAvailable,
} from '../services/tenantAdminService'
import { getBranchCountsByOrgIds } from '../services/branchService'
import './TenantAdmin.css'

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
  const [branchCounts, setBranchCounts] = useState({})
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

  // Edit pharmacy modal
  const [editOrg, setEditOrg] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [saving, setSaving] = useState(false)

  // Edit user modal
  const [editUser, setEditUser] = useState(null)
  const [editUserForm, setEditUserForm] = useState({})
  const [savingUser, setSavingUser] = useState(false)

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
      const [counts, bCounts] = await Promise.all([
        getOrganizationUserCounts(ids),
        getBranchCountsByOrgIds(ids),
      ])
      setUserCounts(counts)
      setBranchCounts(bCounts)
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

  const openEdit = (org) => {
    setEditOrg(org)
    setEditForm({
      name: org.name || '',
      phone: org.phone || '',
      email: org.email || '',
      address: org.address || '',
      city: org.city || '',
      region: org.region || '',
      licenseNumber: org.license_number || '',
      status: org.status || 'trial',
      subscriptionTier: org.subscription_tier || 'basic',
      trialEndsAt: org.trial_ends_at ? org.trial_ends_at.split('T')[0] : '',
      subscriptionEndsAt: org.subscription_ends_at ? org.subscription_ends_at.split('T')[0] : '',
    })
  }

  const closeEdit = () => {
    setEditOrg(null)
    setEditForm({})
  }

  const openEditUser = (user) => {
    setEditUser(user)
    setEditUserForm({
      fullName: user.full_name || '',
      email: user.email || '',
      role: user.role || 'pharmacist',
      isActive: user.is_active !== false,
    })
  }

  const closeEditUser = () => {
    setEditUser(null)
    setEditUserForm({})
  }

  const handleSaveUser = async (e) => {
    e.preventDefault()
    if (!editUserForm.fullName.trim()) return setError('Full name is required')
    setSavingUser(true)
    setError('')
    try {
      await updateOrganizationUser(editUser.id, editUserForm)
      // Refresh the expanded org's user list
      const orgId = editUser.organization_id
      const updated = await getOrganizationUsers(orgId)
      setOrgUsers((prev) => ({ ...prev, [orgId]: updated }))
      notify(`${editUserForm.fullName} updated successfully`, 'success')
      closeEditUser()
    } catch (err) {
      setError(err.message || 'Failed to save user')
    } finally {
      setSavingUser(false)
    }
  }

  const handleSaveEdit = async (e) => {
    e.preventDefault()
    if (!editForm.name.trim()) return setError('Pharmacy name is required')
    setSaving(true)
    setError('')
    try {
      await updateOrganizationDetails(editOrg.id, {
        ...editForm,
        trialEndsAt: editForm.trialEndsAt ? new Date(editForm.trialEndsAt).toISOString() : null,
        subscriptionEndsAt: editForm.subscriptionEndsAt ? new Date(editForm.subscriptionEndsAt).toISOString() : null,
      })
      notify(`${editForm.name} updated successfully`, 'success')
      closeEdit()
      await load()
    } catch (err) {
      setError(err.message || 'Failed to save changes')
    } finally {
      setSaving(false)
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
                  {subdomainOk === true && <p className="field-hint available">Available</p>}
                  {subdomainOk === false && <p className="field-hint taken">Already taken</p>}
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
                    <option value="pro">Professional</option>
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
                  <th>Branches</th>
                  <th>Registered</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <Fragment key={org.id}>
                    <tr className={expandedOrgId === org.id ? 'expanded' : ''}>
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
                          <option value="cancelled">Cancelled</option>
                        </select>
                      </td>
                      <td>
                        <select
                          className="tier-select"
                          value={org.subscription_tier}
                          onChange={(e) => handleTierChange(org.id, e.target.value)}
                        >
                          <option value="trial">Trial</option>
                          <option value="basic">Basic</option>
                          <option value="pro">Professional</option>
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
                        <span className="user-count">
                          <GitBranch size={13} />
                          {branchCounts[org.id] || 0}
                        </span>
                      </td>
                      <td>
                        <span className="date-cell">
                          {new Date(org.created_at).toLocaleDateString()}
                        </span>
                      </td>
                      <td>
                        <div className="table-actions">
                          <button
                            className="btn-icon"
                            title="Edit pharmacy"
                            onClick={() => openEdit(org)}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="btn-icon"
                            title="View users"
                            onClick={() => toggleExpand(org.id)}
                          >
                            <Eye size={15} />
                            {expandedOrgId === org.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* Expanded users row */}
                    {expandedOrgId === org.id && (
                      <tr className="users-expand-row">
                        <td colSpan={8}>
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
                                      <th></th>
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
                                        <td>
                                          <button
                                            className="btn-icon"
                                            title="Edit user"
                                            onClick={() => openEditUser({ ...u, organization_id: org.id })}
                                          >
                                            <Pencil size={13} />
                                          </button>
                                        </td>
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
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit User Modal */}
      {editUser && (
        <div className="modal-backdrop" onClick={closeEditUser}>
          <div className="edit-modal edit-modal--sm" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h3>Edit User</h3>
              <button type="button" className="modal-close" onClick={closeEditUser}>
                x
              </button>
            </div>

            {error && <div className="tenant-alert">{error}</div>}

            <form onSubmit={handleSaveUser} className="edit-modal-body">
              <div className="tenant-form-section">
                <div className="tenant-form-grid">
                  <div className="tenant-form-group full-width">
                    <label>Full Name *</label>
                    <input
                      value={editUserForm.fullName}
                      onChange={(e) => setEditUserForm({ ...editUserForm, fullName: e.target.value })}
                      required
                    />
                  </div>
                  <div className="tenant-form-group full-width">
                    <label>Email</label>
                    <input
                      type="email"
                      value={editUserForm.email}
                      onChange={(e) => setEditUserForm({ ...editUserForm, email: e.target.value })}
                      placeholder="user@example.com"
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>Role</label>
                    <select
                      value={editUserForm.role}
                      onChange={(e) => setEditUserForm({ ...editUserForm, role: e.target.value })}
                    >
                      <option value="admin">Admin</option>
                      <option value="pharmacist">Pharmacist</option>
                      <option value="assistant">Assistant</option>
                    </select>
                  </div>
                  <div className="tenant-form-group">
                    <label>Status</label>
                    <select
                      value={editUserForm.isActive ? 'active' : 'inactive'}
                      onChange={(e) => setEditUserForm({ ...editUserForm, isActive: e.target.value === 'active' })}
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="edit-modal-footer">
                <button type="button" className="btn btn-outline" onClick={closeEditUser} disabled={savingUser}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingUser}>
                  {savingUser ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Pharmacy Modal */}
      {editOrg && (
        <div className="modal-backdrop" onClick={closeEdit}>
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h3>Edit Pharmacy</h3>
              <button type="button" className="modal-close" onClick={closeEdit}>
                x
              </button>
            </div>

            {error && <div className="tenant-alert">{error}</div>}

            <form onSubmit={handleSaveEdit} className="edit-modal-body">
              <div className="tenant-form-section">
                <h4>Pharmacy Details</h4>
                <div className="tenant-form-grid">
                  <div className="tenant-form-group full-width">
                    <label>Pharmacy Name *</label>
                    <input
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>Phone</label>
                    <input
                      value={editForm.phone}
                      onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                      placeholder="+233 123 456 789"
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>Email</label>
                    <input
                      type="email"
                      value={editForm.email}
                      onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                      placeholder="info@pharmacy.com"
                    />
                  </div>
                  <div className="tenant-form-group full-width">
                    <label>Address</label>
                    <input
                      value={editForm.address}
                      onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                      placeholder="123 Main Street"
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>City</label>
                    <input
                      value={editForm.city}
                      onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                      placeholder="Accra"
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>Region</label>
                    <input
                      value={editForm.region}
                      onChange={(e) => setEditForm({ ...editForm, region: e.target.value })}
                      placeholder="Greater Accra"
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>License Number</label>
                    <input
                      value={editForm.licenseNumber}
                      onChange={(e) => setEditForm({ ...editForm, licenseNumber: e.target.value })}
                      placeholder="PL-12345"
                    />
                  </div>
                </div>
              </div>

              <div className="tenant-form-section">
                <h4>Subscription</h4>
                <div className="tenant-form-grid">
                  <div className="tenant-form-group">
                    <label>Status</label>
                    <select
                      value={editForm.status}
                      onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                    >
                      <option value="trial">Trial</option>
                      <option value="active">Active</option>
                      <option value="suspended">Suspended</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                  <div className="tenant-form-group">
                    <label>Subscription Tier</label>
                    <select
                      value={editForm.subscriptionTier}
                      onChange={(e) => setEditForm({ ...editForm, subscriptionTier: e.target.value })}
                    >
                      <option value="trial">Trial</option>
                      <option value="basic">Basic</option>
                      <option value="pro">Professional</option>
                      <option value="enterprise">Enterprise</option>
                    </select>
                  </div>
                  <div className="tenant-form-group">
                    <label>Trial Ends</label>
                    <input
                      type="date"
                      value={editForm.trialEndsAt}
                      onChange={(e) => setEditForm({ ...editForm, trialEndsAt: e.target.value })}
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>Subscription Ends</label>
                    <input
                      type="date"
                      value={editForm.subscriptionEndsAt}
                      onChange={(e) => setEditForm({ ...editForm, subscriptionEndsAt: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              <div className="edit-modal-footer">
                <button type="button" className="btn btn-outline" onClick={closeEdit} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default TenantAdmin
