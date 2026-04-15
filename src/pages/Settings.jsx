import { useEffect, useState } from 'react'
import { User, UserPlus, Lock, Bell, Building, Palette } from 'lucide-react'
import { isSupabaseConfigured } from '../lib/supabase'
import {
  createStaffUser,
  getPharmacySettings,
  getUsers,
  updatePharmacySettings,
  updateUserStatus,
} from '../services/settingsService'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
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
})

const blankStaffForm = {
  fullName: '',
  email: '',
  phone: '',
  role: 'assistant',
  temporaryPassword: '',
}

const Settings = () => {
  const { user, role } = useAuth()
  const { notify } = useNotification()
  const isAdmin = role === 'admin'

  const [settingsId, setSettingsId] = useState('')
  const [formData, setFormData] = useState(toForm(null))
  const [staffForm, setStaffForm] = useState(blankStaffForm)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creatingStaff, setCreatingStaff] = useState(false)
  const [statusUpdatingId, setStatusUpdatingId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    loadSettings()
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
      notify(`User ${!currentStatus ? 'enabled' : 'disabled'} successfully.`, !currentStatus ? 'success' : 'info')
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
              onChange={(e) => setFormData({ ...formData, pharmacyName: e.target.value })}
              disabled={!isAdmin}
            />
            <input
              placeholder="Phone"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              disabled={!isAdmin}
            />
            <input
              placeholder="Email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              disabled={!isAdmin}
            />
            <input
              placeholder="Address"
              value={formData.address}
              onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              disabled={!isAdmin}
            />
            <div className="settings-form-row">
              <input
                placeholder="City"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                disabled={!isAdmin}
              />
              <input
                placeholder="Region"
                value={formData.region}
                onChange={(e) => setFormData({ ...formData, region: e.target.value })}
                disabled={!isAdmin}
              />
            </div>
            <div className="settings-form-row">
              <input
                placeholder="License number"
                value={formData.licenseNumber}
                onChange={(e) => setFormData({ ...formData, licenseNumber: e.target.value })}
                disabled={!isAdmin}
              />
              <input
                placeholder="Currency"
                value={formData.currency}
                onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                disabled={!isAdmin}
              />
            </div>
            <div className="settings-form-row">
              <input
                type="number"
                step="0.01"
                placeholder="Tax rate"
                value={formData.taxRate}
                onChange={(e) => setFormData({ ...formData, taxRate: e.target.value })}
                disabled={!isAdmin}
              />
              <input
                type="number"
                placeholder="Low stock threshold"
                value={formData.lowStockThreshold}
                onChange={(e) => setFormData({ ...formData, lowStockThreshold: e.target.value })}
                disabled={!isAdmin}
              />
            </div>
            <input
              type="number"
              placeholder="Expiry alert days"
              value={formData.expiryAlertDays}
              onChange={(e) => setFormData({ ...formData, expiryAlertDays: e.target.value })}
              disabled={!isAdmin}
            />
            {isAdmin && (
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            )}
          </form>
        </div>

        {isAdmin && (
          <div className="settings-card">
            <div className="card-icon">
              <UserPlus size={24} />
            </div>
            <h3>Staff Onboarding</h3>
            <p className="settings-note">
              Create pharmacist or assistant logins without leaving the app. New staff can sign in immediately with the temporary password below.
            </p>
            <form className="settings-form" onSubmit={handleCreateStaff}>
              <input
                placeholder="Full name"
                value={staffForm.fullName}
                onChange={(e) => setStaffForm({ ...staffForm, fullName: e.target.value })}
                disabled={creatingStaff}
              />
              <input
                type="email"
                placeholder="Email address"
                value={staffForm.email}
                onChange={(e) => setStaffForm({ ...staffForm, email: e.target.value })}
                disabled={creatingStaff}
              />
              <div className="settings-form-row">
                <input
                  placeholder="Phone (optional)"
                  value={staffForm.phone}
                  onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })}
                  disabled={creatingStaff}
                />
                <select
                  value={staffForm.role}
                  onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}
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
                onChange={(e) => setStaffForm({ ...staffForm, temporaryPassword: e.target.value })}
                disabled={creatingStaff}
              />
              <p className="settings-helper">
                Share the temporary password securely, then ask the staff member to use the password reset link after first sign-in.
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
                      <span className={`user-status-badge ${row.is_active ? 'active' : 'inactive'}`}>
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
          <p>Notification engine is queued for the next phase. Threshold values are already captured in pharmacy settings.</p>
        </div>

        <div className="settings-card">
          <div className="card-icon">
            <Lock size={24} />
          </div>
          <h3>Security</h3>
          <p>Role-based routing and RLS are active. Password reset flow is the next item to add.</p>
        </div>

        <div className="settings-card">
          <div className="card-icon">
            <Palette size={24} />
          </div>
          <h3>Appearance</h3>
          <p>Theme customization module is planned after operational feature completion.</p>
        </div>
      </div>

      <div className="about-section">
        <h2>About HealthFlow Pharmacy</h2>
        <p>Version 1.0.0</p>
        <p className="developer-credit">
          Developed by <strong>David Gabion Selorm</strong>
        </p>
        <p className="contact">Email: gabiondavidselorm@gmail.com | Business: zittechgh@gmail.com</p>
        <p className="copyright">© 2026 HealthFlow Pharmacy. All rights reserved.</p>
      </div>
    </div>
  )
}

export default Settings
