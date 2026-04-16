import { useEffect, useState } from 'react'
import { User, UserPlus, Lock, Bell, Building, Palette, Globe } from 'lucide-react'
import { isSupabaseConfigured } from '../lib/supabase'
import {
  createStaffUser,
  getPharmacySettings,
  getUsers,
  updatePharmacySettings,
  updateUserStatus,
} from '../services/settingsService'
import { updateOrganization, getOrganizationStats } from '../services/organizationService'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { useTenant } from '../context/TenantContext'
import './Settings.css'

const toForm = (row) => ({
  pharmacyName: row?.pharmacy_name || 'HealthFlow Pharmacy',
  phone: row?.phone || '',
  email: row?.email || '',
  address: row?.address || '',
  city: row?.city || '',
  region: row?.region || '',
  licenseNumber: row?.license_number || '',
  taxRate: row?.tax_rate ?? 0,
  currency: row?.currency || 'GHS',
  lowStockThreshold: row?.low_stock_threshold ?? 10,
  expiryAlertDays: row?.expiry_alert_days ?? 30,
  receiptFooter: row?.receipt_footer || '',
})

const blankStaffForm = {
  fullName: '',
  email: '',
  phone: '',
  role: 'assistant',
  temporaryPassword: '',
}

const Settings = () => {
  const { user, role, organization } = useAuth()
  const { notify } = useNotification()
  const { isTrialActive, isSubscriptionActive, daysUntilTrialExpires } = useTenant()
  const isAdmin = role === 'admin'

  const [settingsId, setSettingsId] = useState('')
  const [formData, setFormData] = useState(toForm(null))
  const [staffForm, setStaffForm] = useState(blankStaffForm)
  const [users, setUsers] = useState([])
  const [orgStats, setOrgStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creatingStaff, setCreatingStaff] = useState(false)
  const [statusUpdatingId, setStatusUpdatingId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      setLoading(true)
      setError('')

      if (!isSupabaseConfigured()) {
        setError('Supabase is not configured. Update .env to enable settings.')
        return
      }

      const settings = await getPharmacySettings()
      setSettingsId(settings.id)
      setFormData(toForm(settings))

      if (isAdmin) {
        const usersData = await getUsers()
        setUsers(usersData)

        // Load organization stats
        if (organization?.id) {
          const stats = await getOrganizationStats(organization.id)
          setOrgStats(stats)
        }
      }
    } catch (loadError) {
      console.error('Error loading settings:', loadError)
      setError(loadError.message || 'Unable to load settings.')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (event) => {
    event.preventDefault()

    try {
      setSaving(true)
      setError('')
      await updatePharmacySettings(settingsId, formData)
      await loadSettings()
    } catch (saveError) {
      console.error('Error saving settings:', saveError)
      setError(saveError.message || 'Unable to save settings.')
    } finally {
      setSaving(false)
    }
  }

  const toggleUserStatus = async (id, currentStatus) => {
    if (id === user?.id && currentStatus) {
      setError('Your current admin account cannot be disabled from this screen.')
      return
    }

    try {
      setStatusUpdatingId(id)
      setError('')
      await updateUserStatus(id, !currentStatus)
      notify(
        `User ${!currentStatus ? 'enabled' : 'disabled'} successfully.`,
        !currentStatus ? 'success' : 'info'
      )
      await loadSettings()
    } catch (statusError) {
      setError(statusError.message || 'Unable to update user status.')
    } finally {
      setStatusUpdatingId('')
    }
  }

  const handleCreateStaff = async (event) => {
    event.preventDefault()

    try {
      setCreatingStaff(true)
      setError('')
      const createdUser = await createStaffUser(staffForm)
      notify(
        `Staff account ready for ${createdUser.email}. Share the temporary password securely.`,
        'success',
        5000
      )
      setStaffForm(blankStaffForm)
      await loadSettings()
    } catch (createError) {
      setError(createError.message || 'Unable to create staff account.')
    } finally {
      setCreatingStaff(false)
    }
  }

  if (loading) {
    return (
      <div className="settings-page">
        <div className="page-header">
          <h1>Loading settings...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Manage your pharmacy system preferences</p>
      </div>

      {error && <div className="settings-alert">{error}</div>}

      <div className="settings-grid">
        <div className="settings-card">
          <div className="card-icon">
            <Building size={24} />
          </div>
          <h3>Pharmacy Information</h3>
          <form className="settings-form" onSubmit={handleSave}>
            <input
              placeholder="Pharmacy name"
              value={formData.pharmacyName}
              onChange={(event) =>
                setFormData({ ...formData, pharmacyName: event.target.value })
              }
              disabled={!isAdmin}
            />
            <input
              placeholder="Phone"
              value={formData.phone}
              onChange={(event) => setFormData({ ...formData, phone: event.target.value })}
              disabled={!isAdmin}
            />
            <input
              placeholder="Email"
              value={formData.email}
              onChange={(event) => setFormData({ ...formData, email: event.target.value })}
              disabled={!isAdmin}
            />
            <input
              placeholder="Address"
              value={formData.address}
              onChange={(event) =>
                setFormData({ ...formData, address: event.target.value })
              }
              disabled={!isAdmin}
            />
            <div className="settings-form-row">
              <input
                placeholder="City"
                value={formData.city}
                onChange={(event) => setFormData({ ...formData, city: event.target.value })}
                disabled={!isAdmin}
              />
              <input
                placeholder="Region"
                value={formData.region}
                onChange={(event) => setFormData({ ...formData, region: event.target.value })}
                disabled={!isAdmin}
              />
            </div>
            <div className="settings-form-row">
              <input
                placeholder="License number"
                value={formData.licenseNumber}
                onChange={(event) =>
                  setFormData({ ...formData, licenseNumber: event.target.value })
                }
                disabled={!isAdmin}
              />
              <input
                placeholder="Currency"
                value={formData.currency}
                onChange={(event) =>
                  setFormData({ ...formData, currency: event.target.value })
                }
                disabled={!isAdmin}
              />
            </div>
            <div className="settings-form-row">
              <input
                type="number"
                step="0.01"
                placeholder="Tax rate"
                value={formData.taxRate}
                onChange={(event) =>
                  setFormData({ ...formData, taxRate: event.target.value })
                }
                disabled={!isAdmin}
              />
              <input
                type="number"
                placeholder="Low stock threshold"
                value={formData.lowStockThreshold}
                onChange={(event) =>
                  setFormData({
                    ...formData,
                    lowStockThreshold: event.target.value,
                  })
                }
                disabled={!isAdmin}
              />
            </div>
            <input
              type="number"
              placeholder="Expiry alert days"
              value={formData.expiryAlertDays}
              onChange={(event) =>
                setFormData({ ...formData, expiryAlertDays: event.target.value })
              }
              disabled={!isAdmin}
            />
            <textarea
              placeholder="Receipt footer message (optional)"
              value={formData.receiptFooter}
              onChange={(event) =>
                setFormData({ ...formData, receiptFooter: event.target.value })
              }
              disabled={!isAdmin}
              rows={3}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
            />
            {isAdmin && (
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            )}
          </form>
        </div>

        {isAdmin && organization && (
          <div className="settings-card">
            <div className="card-icon">
              <Globe size={24} />
            </div>
            <h3>Organization</h3>
            <div className="org-info">
              <div className="org-info-row">
                <span className="org-label">Organization Name:</span>
                <span className="org-value">{organization.name}</span>
              </div>
              <div className="org-info-row">
                <span className="org-label">Subdomain:</span>
                <span className="org-value">{organization.subdomain}.healthflow.app</span>
              </div>
              <div className="org-info-row">
                <span className="org-label">Status:</span>
                <span className={`org-status-badge ${organization.status}`}>
                  {organization.status === 'trial' && isTrialActive
                    ? `Trial (${daysUntilTrialExpires} days left)`
                    : organization.status === 'active' && isSubscriptionActive
                      ? 'Active Subscription'
                      : organization.status === 'suspended'
                        ? 'Suspended'
                        : 'Inactive'}
                </span>
              </div>
              <div className="org-info-row">
                <span className="org-label">Subscription Tier:</span>
                <span className="org-value">{organization.subscription_tier}</span>
              </div>
              {organization.license_number && (
                <div className="org-info-row">
                  <span className="org-label">License Number:</span>
                  <span className="org-value">{organization.license_number}</span>
                </div>
              )}
              {orgStats && (
                <>
                  <div className="org-divider"></div>
                  <h4 className="org-stats-title">Usage Statistics</h4>
                  <div className="org-stats-grid">
                    <div className="org-stat">
                      <span className="org-stat-value">{orgStats.totalUsers}</span>
                      <span className="org-stat-label">Users</span>
                    </div>
                    <div className="org-stat">
                      <span className="org-stat-value">{orgStats.totalDrugs}</span>
                      <span className="org-stat-label">Drugs</span>
                    </div>
                    <div className="org-stat">
                      <span className="org-stat-value">{orgStats.totalPatients}</span>
                      <span className="org-stat-label">Patients</span>
                    </div>
                    <div className="org-stat">
                      <span className="org-stat-value">{orgStats.totalSales}</span>
                      <span className="org-stat-label">Sales</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="settings-card">
            <div className="card-icon">
              <UserPlus size={24} />
            </div>
            <h3>Staff Onboarding</h3>
            <p className="settings-note">
              Create pharmacist or assistant logins without leaving the app. New staff can sign
              in immediately with the temporary password below.
            </p>
            <form className="settings-form" onSubmit={handleCreateStaff}>
              <input
                placeholder="Full name"
                value={staffForm.fullName}
                onChange={(event) =>
                  setStaffForm({ ...staffForm, fullName: event.target.value })
                }
                disabled={creatingStaff}
              />
              <input
                type="email"
                placeholder="Email address"
                value={staffForm.email}
                onChange={(event) =>
                  setStaffForm({ ...staffForm, email: event.target.value })
                }
                disabled={creatingStaff}
              />
              <div className="settings-form-row">
                <input
                  placeholder="Phone (optional)"
                  value={staffForm.phone}
                  onChange={(event) =>
                    setStaffForm({ ...staffForm, phone: event.target.value })
                  }
                  disabled={creatingStaff}
                />
                <select
                  value={staffForm.role}
                  onChange={(event) =>
                    setStaffForm({ ...staffForm, role: event.target.value })
                  }
                  disabled={creatingStaff}
                >
                  <option value="assistant">Assistant</option>
                  <option value="pharmacist">Pharmacist</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <input
                type="password"
                minLength={8}
                placeholder="Temporary password"
                value={staffForm.temporaryPassword}
                onChange={(event) =>
                  setStaffForm({
                    ...staffForm,
                    temporaryPassword: event.target.value,
                  })
                }
                disabled={creatingStaff}
              />
              <p className="settings-helper">
                Share the temporary password securely, then ask the staff member to use the
                password reset link after first sign-in.
              </p>
              <button className="btn btn-primary" type="submit" disabled={creatingStaff}>
                {creatingStaff ? 'Creating Account...' : 'Create Staff Account'}
              </button>
            </form>
          </div>
        )}

        {isAdmin && (
          <div className="settings-card">
            <div className="card-icon">
              <User size={24} />
            </div>
            <h3>User Management</h3>
            <div className="user-list">
              {users.map((row) => (
                <div key={row.id} className="user-row">
                  <div>
                    <strong>{row.full_name}</strong>
                    <p>{row.email}</p>
                    <div className="user-meta">
                      <small>{row.role}</small>
                      <span
                        className={`user-status-badge ${row.is_active ? 'active' : 'inactive'}`}
                      >
                        {row.is_active ? 'Active' : 'Disabled'}
                      </span>
                    </div>
                  </div>
                  <div className="user-actions">
                    <button
                      className={`btn ${row.is_active ? 'btn-outline' : 'btn-primary'}`}
                      onClick={() => toggleUserStatus(row.id, row.is_active)}
                      type="button"
                      disabled={statusUpdatingId === row.id || row.id === user?.id}
                    >
                      {row.id === user?.id
                        ? 'Current Account'
                        : statusUpdatingId === row.id
                          ? 'Updating...'
                          : row.is_active
                            ? 'Disable'
                            : 'Enable'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="settings-card">
          <div className="card-icon">
            <Bell size={24} />
          </div>
          <h3>Notifications</h3>
          <p>
            Operational alerts are available from the top bar and use low stock, expiring stock,
            and pending claims data.
          </p>
        </div>

        <div className="settings-card">
          <div className="card-icon">
            <Lock size={24} />
          </div>
          <h3>Security</h3>
          <p>
            Role-based routing, RLS, and password reset are active for current production users.
          </p>
        </div>

        <div className="settings-card">
          <div className="card-icon">
            <Palette size={24} />
          </div>
          <h3>Appearance</h3>
          <p>
            The interface uses the current HealthFlow brand palette for consistency across pharmacy
            workstations.
          </p>
        </div>
      </div>

      <div className="about-section">
        <h2>About HealthFlow Pharmacy</h2>
        <p>Version 1.0.0</p>
        <p className="developer-credit">
          Developed by <strong>David Gabion Selorm</strong>
        </p>
        <p className="contact">Email: gabiondavidselorm@gmail.com | Business: zittechgh@gmail.com</p>
        <p className="company">Developed by <strong>Neon Digital Technologies</strong></p>
        <p className="website">🌐 <a href="https://www.neondigitaltechnologies.com" target="_blank" rel="noopener noreferrer">www.neondigitaltechnologies.com</a></p>
        <p className="copyright">Copyright 2026 HealthFlow Pharmacy. All rights reserved.</p>
      </div>
    </div>
  )
}

export default Settings
