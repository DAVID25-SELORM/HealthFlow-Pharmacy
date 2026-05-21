import { useEffect, useState } from 'react'
import { User, UserPlus, Lock, Bell, Building, Palette, Globe, GitBranch, Plus, KeyRound } from 'lucide-react'
import { isSupabaseConfigured } from '../lib/supabase'
import UpgradeGate from '../components/UpgradeGate'
import GhanaRegionSelect from '../components/GhanaRegionSelect'
import {
  createStaffUser,
  getPharmacySettings,
  getUsers,
  updatePharmacySettings,
  updateUserRefundPermission,
  updateUserStatus,
  updateUserBranch,
} from '../services/settingsService'
import { getBranches, createBranch, updateBranch, deactivateBranch } from '../services/branchService'
import { updateOrganization, getOrganizationStats } from '../services/organizationService'
import { buildClaimItConfigPreview, getNhiaApiSettings, saveNhiaApiSettings } from '../services/nhisService'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { normalizeSubscriptionTier, useTenant } from '../context/TenantContext'
import { readLogoFileAsDataUrl, readSignatureFileAsDataUrl } from '../utils/imageUpload'
import { normalizeGhanaRegion } from '../utils/ghanaRegions'
import { getRoleLabel } from '../utils/roleLabels'
import { ROLE_OPTIONS } from '../utils/roles'
import { applyNhiaFacilityDefaults } from '../utils/nhiaFacilityDefaults'
// ✅ NHIS PHARMACY LEVEL PATCH START
import { PHARMACY_LEVELS } from '../utils/nhisPharmacyLevel'
// ✅ NHIS PHARMACY LEVEL PATCH END
import './Settings.css'

const toForm = (row) => ({
  pharmacyName: row?.pharmacy_name || 'HealthFlow Pharmacy',
  phone: row?.phone || '',
  email: row?.email || '',
  address: row?.address || '',
  city: row?.city || '',
  region: normalizeGhanaRegion(row?.region),
  logoUrl: row?.logo_url || '',
  slogan: row?.slogan || '',
  licenseNumber: row?.license_number || '',
  // ✅ NHIS PHARMACY LEVEL PATCH START
  pharmacyLevel: row?.pharmacy_level || '',
  // ✅ NHIS PHARMACY LEVEL PATCH END
  taxRate: row?.tax_rate ?? 0,
  currency: row?.currency || 'GHS',
  defaultMarkupPercent: row?.default_markup_percent ?? 0,
  lowStockThreshold: row?.low_stock_threshold ?? 10,
  expiryAlertDays: row?.expiry_alert_days ?? 30,
  receiptFooter: row?.receipt_footer || '',
})

const blankNhiaApiForm = {
  facilityCode: '',
  providerNumber: '',
  schemeName: 'National Health Insurance',
  // ✅ NHIA CONFIG PATCH START
  facilityType: 'Pharmacy',
  pharmacyFacilityLevel: '',
  providerLevelCode: '',
  credentialCode: '',
  licenseNumber: '',
  accreditationExpiryDate: '',
  // ✅ NHIA CONFIG PATCH END
  providerTypeDescription: '',
  providerClassLevel: '',
  claimsOfficerName: '',
  admissionPaymentOption: 'nhis_pays_admission',
  claimitValidationEnabled: true,
  claimsOfficerSignatureUrl: '',
  submitterId: '',
  apiEnvironment: 'production',
  apiBaseUrl: '',
  claimEndpointPath: '',
  ccCodeEndpointPath: '',
  claimStatusEndpointPath: '',
  memberLookupEndpointPath: '',
  directApiEnabled: false,
  credentialMode: 'api_key',
  exportFormat: 'json',
  credentials: {
    apiKey: '',
    apiSecret: '',
    headerName: '',
    secretHeaderName: '',
    headerPrefix: '',
    clientId: '',
    clientSecret: '',
    username: '',
    password: '',
    token: '',
    tokenEndpointPath: '',
  },
}

const toNhiaApiForm = (settings, organization) => {
  const resolved = applyNhiaFacilityDefaults(settings, organization)
  return {
    ...blankNhiaApiForm,
    ...resolved,
    credentials: { ...blankNhiaApiForm.credentials },
  }
}

const blankStaffForm = {
  fullName: '',
  email: '',
  phone: '',
  role: 'assistant',
  canRefund: false,
  canManageInventory: false,
  canViewReports: false,
  canManageClaims: false,
  temporaryPassword: '',
  branchId: '',
}

const blankBranchForm = {
  name: '', code: '', phone: '', email: '', address: '', city: '', region: '',
}

const formatSubscriptionTier = (tier) => {
  const normalizedTier = normalizeSubscriptionTier(tier)

  if (normalizedTier === 'pro') {
    return 'Professional'
  }

  return normalizedTier.charAt(0).toUpperCase() + normalizedTier.slice(1)
}

const Settings = () => {
  const { user, role, organization, refreshProfile } = useAuth()
  const { notify } = useNotification()
  const {
    isTrialActive,
    isSubscriptionActive,
    daysUntilTrialExpires,
    tierLimits,
    canUseMultiBranch,
  } = useTenant()
  const isAdmin = role === 'admin'

  const [settingsId, setSettingsId] = useState('')
  const [formData, setFormData] = useState(toForm(null))
  const [staffForm, setStaffForm] = useState(blankStaffForm)
  const [users, setUsers] = useState([])
  const [orgStats, setOrgStats] = useState(null)
  const [nhiaApiForm, setNhiaApiForm] = useState(blankNhiaApiForm)
  const [savingNhiaApi, setSavingNhiaApi] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creatingStaff, setCreatingStaff] = useState(false)
  const [statusUpdatingId, setStatusUpdatingId] = useState('')
  const [refundPermissionUpdatingId, setRefundPermissionUpdatingId] = useState('')
  const [branchUpdatingId, setBranchUpdatingId] = useState('')
  const [error, setError] = useState('')

  // Branch state
  const [branches, setBranches] = useState([])
  const [showBranchForm, setShowBranchForm] = useState(false)
  const [branchForm, setBranchForm] = useState(blankBranchForm)
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [editingBranchId, setEditingBranchId] = useState(null)
  const [editBranchForm, setEditBranchForm] = useState({})
  const [savingBranch, setSavingBranch] = useState(false)
  const atUserLimit = tierLimits.maxUsers !== Infinity && users.length >= tierLimits.maxUsers
  const activeBranches = branches.filter((branch) => branch.is_active !== false)
  const singleActiveBranch = activeBranches.length === 1 ? activeBranches[0] : null
  // ✅ NHIA CONFIG PATCH START
  const claimItPreview = buildClaimItConfigPreview({
    ...nhiaApiForm,
    facilityName: organization?.name || formData.pharmacyName,
  }, { organizationType: organization?.organization_type || 'pharmacy' })
  // ✅ NHIA CONFIG PATCH END

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
        const [usersData, branchesData, nhiaApiSettings] = await Promise.all([
          getUsers(),
          getBranches(),
          getNhiaApiSettings().catch(() => null),
        ])
        setUsers(usersData)
        setBranches(branchesData)
        setNhiaApiForm(toNhiaApiForm(nhiaApiSettings, organization))

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
      if (organization?.id) {
        await updateOrganization(organization.id, {
          name: formData.pharmacyName,
          phone: formData.phone,
          email: formData.email,
          address: formData.address,
          city: formData.city,
          region: formData.region,
          logoUrl: formData.logoUrl,
          slogan: formData.slogan,
          licenseNumber: formData.licenseNumber,
        })
      }
      await loadSettings()
      notify('Pharmacy settings saved.', 'success')
    } catch (saveError) {
      console.error('Error saving settings:', saveError)
      setError(saveError.message || 'Unable to save settings.')
    } finally {
      setSaving(false)
    }
  }

  const updateNhiaApiForm = (field, value) => {
    setNhiaApiForm((current) => ({ ...current, [field]: value }))
  }

  const updateNhiaCredential = (field, value) => {
    setNhiaApiForm((current) => ({
      ...current,
      credentials: {
        ...current.credentials,
        [field]: value,
      },
    }))
  }

  const handleSaveNhiaApi = async (event) => {
    event.preventDefault()

    try {
      setSavingNhiaApi(true)
      setError('')
      await saveNhiaApiSettings(nhiaApiForm)
      await loadSettings()
      notify('NHIA API settings saved.', 'success')
    } catch (saveError) {
      setError(saveError.message || 'Unable to save NHIA API settings.')
    } finally {
      setSavingNhiaApi(false)
    }
  }

  const handleLogoChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setError('')
      const logoUrl = await readLogoFileAsDataUrl(file)
      setFormData((current) => ({ ...current, logoUrl }))
    } catch (logoError) {
      setError(logoError.message || 'Unable to upload logo.')
    } finally {
      event.target.value = ''
    }
  }

  const handleNhiaSignatureChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setError('')
      const signatureUrl = await readSignatureFileAsDataUrl(file)
      setNhiaApiForm((current) => ({ ...current, claimsOfficerSignatureUrl: signatureUrl }))
    } catch (signatureError) {
      setError(signatureError.message || 'Unable to upload claims officer signature.')
    } finally {
      event.target.value = ''
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

  const toggleRefundPermission = async (row) => {
    try {
      setRefundPermissionUpdatingId(row.id)
      setError('')
      const nextValue = !row.can_refund
      await updateUserRefundPermission(row.id, nextValue)
      notify(
        nextValue
          ? `${row.full_name} can now process refunds.`
          : `${row.full_name} can no longer process refunds.`,
        nextValue ? 'success' : 'info'
      )
      await loadSettings()
    } catch (permissionError) {
      setError(permissionError.message || 'Unable to update refund permission.')
    } finally {
      setRefundPermissionUpdatingId('')
    }
  }

  const handleCreateStaff = async (event) => {
    event.preventDefault()

    try {
      setCreatingStaff(true)
      setError('')
      const selectedBranchId = staffForm.branchId || singleActiveBranch?.id || ''
      if (activeBranches.length > 1 && !selectedBranchId) {
        throw new Error('Select the staff member branch before creating the account.')
      }
      const createdUser = await createStaffUser(staffForm)
      if (selectedBranchId && createdUser?.id) {
        await updateUserBranch(createdUser.id, selectedBranchId)
      }
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

  const handleUserBranchChange = async (row, branchId) => {
    try {
      setBranchUpdatingId(row.id)
      setError('')
      const updatedUser = await updateUserBranch(row.id, branchId)
      if (updatedUser?.id) {
        setUsers((current) =>
          current.map((userRow) =>
            userRow.id === updatedUser.id ? { ...userRow, ...updatedUser } : userRow
          )
        )
      }
      if (row.id === user?.id && refreshProfile) {
        await refreshProfile()
      }
      notify(`${row.full_name} branch updated.`, 'success')
      await loadSettings()
    } catch (branchError) {
      setError(branchError.message || 'Unable to update user branch.')
    } finally {
      setBranchUpdatingId('')
    }
  }

  const handleCreateBranch = async (e) => {
    e.preventDefault()
    if (!branchForm.name.trim()) return setError('Branch name is required')
    if (!canUseMultiBranch && activeBranches.length >= 1) {
      return setError('Multi-branch is locked for this pharmacy. Enable it from Tenant Admin before adding another branch.')
    }
    setCreatingBranch(true)
    setError('')
    try {
      await createBranch(branchForm)
      notify(`Branch "${branchForm.name}" created`, 'success')
      setBranchForm(blankBranchForm)
      setShowBranchForm(false)
      await loadSettings()
    } catch (err) {
      setError(err.message || 'Failed to create branch')
    } finally {
      setCreatingBranch(false)
    }
  }

  const openEditBranch = (br) => {
    setEditingBranchId(br.id)
    setEditBranchForm({
      name: br.name || '',
      code: br.code || '',
      phone: br.phone || '',
      email: br.email || '',
      address: br.address || '',
      city: br.city || '',
      region: normalizeGhanaRegion(br.region),
    })
  }

  const handleSaveBranch = async (e, branchId) => {
    e.preventDefault()
    if (!editBranchForm.name.trim()) return setError('Branch name is required')
    setSavingBranch(true)
    setError('')
    try {
      await updateBranch(branchId, editBranchForm)
      notify('Branch updated', 'success')
      setEditingBranchId(null)
      await loadSettings()
    } catch (err) {
      setError(err.message || 'Failed to update branch')
    } finally {
      setSavingBranch(false)
    }
  }

  const handleDeactivateBranch = async (branchId) => {
    setError('')
    try {
      await deactivateBranch(branchId)
      notify('Branch deactivated', 'info')
      await loadSettings()
    } catch (err) {
      setError(err.message || 'Failed to deactivate branch')
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
              <GhanaRegionSelect
                value={formData.region}
                onChange={(event) => setFormData({ ...formData, region: event.target.value })}
                disabled={!isAdmin}
              />
            </div>
            <div className="settings-form-row">
              <input
                placeholder="Pharmacy slogan"
                value={formData.slogan}
                onChange={(event) =>
                  setFormData({ ...formData, slogan: event.target.value })
                }
                disabled={!isAdmin}
                maxLength={120}
              />
              <input
                placeholder="License number"
                value={formData.licenseNumber}
                onChange={(event) =>
                  setFormData({ ...formData, licenseNumber: event.target.value })
                }
                disabled={!isAdmin}
              />
            </div>
            {/* ✅ NHIS PHARMACY LEVEL PATCH START */}
            <label className="settings-field">
              <span>Pharmacy / facility level</span>
              <select
                value={formData.pharmacyLevel}
                onChange={(event) => setFormData({ ...formData, pharmacyLevel: event.target.value })}
                disabled={!isAdmin}
              >
                <option value="">Level not configured</option>
                {PHARMACY_LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>{level.label}</option>
                ))}
              </select>
            </label>
            {/* ✅ NHIS PHARMACY LEVEL PATCH END */}
            <label className="settings-field">
              <span>Currency</span>
              <input
                placeholder="Currency"
                value={formData.currency}
                onChange={(event) =>
                  setFormData({ ...formData, currency: event.target.value })
                }
                disabled={!isAdmin}
              />
            </label>
            <div className="logo-upload-field">
              {formData.logoUrl && (
                <img src={formData.logoUrl} alt="Pharmacy logo preview" className="settings-logo-preview" />
              )}
              <label htmlFor="pharmacyLogo">Pharmacy logo</label>
              <input
                id="pharmacyLogo"
                type="file"
                accept="image/*"
                onChange={handleLogoChange}
                disabled={!isAdmin}
              />
              {isAdmin && formData.logoUrl && (
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setFormData({ ...formData, logoUrl: '' })}
                >
                  Remove Logo
                </button>
              )}
            </div>
            <div className="settings-form-row">
              <label className="settings-field">
                <span>Tax rate (%)</span>
                <input
                  type="number"
                  step="0.01"
                  placeholder="0"
                  value={formData.taxRate}
                  onChange={(event) =>
                    setFormData({ ...formData, taxRate: event.target.value })
                  }
                  disabled={!isAdmin}
                />
              </label>
              <label className="settings-field">
                <span>Default markup (%)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0"
                  value={formData.defaultMarkupPercent}
                  onChange={(event) =>
                    setFormData({
                      ...formData,
                      defaultMarkupPercent: event.target.value,
                    })
                  }
                  disabled={!isAdmin}
                />
              </label>
            </div>
            <div className="settings-form-row">
              <label className="settings-field">
                <span>Low stock threshold</span>
                <input
                  type="number"
                  placeholder="10"
                  value={formData.lowStockThreshold}
                  onChange={(event) =>
                    setFormData({
                      ...formData,
                      lowStockThreshold: event.target.value,
                    })
                  }
                  disabled={!isAdmin}
                />
              </label>
              <label className="settings-field">
                <span>Expiry alert days</span>
                <input
                  type="number"
                  placeholder="30"
                  value={formData.expiryAlertDays}
                  onChange={(event) =>
                    setFormData({ ...formData, expiryAlertDays: event.target.value })
                  }
                  disabled={!isAdmin}
                />
              </label>
            </div>
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
              <div className="settings-save-bar">
                <span>Save pharmacy details, slogan, logo, and receipt footer.</span>
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
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
                        : organization.status === 'cancelled'
                          ? 'Cancelled'
                          : organization.status}
                </span>
              </div>
              <div className="org-info-row">
                <span className="org-label">Subscription Tier:</span>
                <span className="org-value">{formatSubscriptionTier(organization.subscription_tier)}</span>
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

        {isAdmin && organization?.can_use_nhis && (
          <div className="settings-card">
            <div className="card-icon">
              <KeyRound size={24} />
            </div>
            <h3>NHIA API</h3>
            <p className="settings-note">
              Store the NHIA/CLAIM-it issued API details for CCC/CC generation and direct claim submission.
            </p>
            <form className="settings-form" onSubmit={handleSaveNhiaApi}>
              <label className="settings-checkbox-label">
                <input
                  type="checkbox"
                  checked={Boolean(nhiaApiForm.directApiEnabled)}
                  onChange={(event) => updateNhiaApiForm('directApiEnabled', event.target.checked)}
                />
                Enable direct NHIA API
              </label>
              <div className="settings-form-row">
                <input
                  placeholder="Scheme name"
                  value={nhiaApiForm.schemeName}
                  onChange={(event) => updateNhiaApiForm('schemeName', event.target.value)}
                />
                <input
                  placeholder="Facility code"
                  value={nhiaApiForm.facilityCode}
                  onChange={(event) => updateNhiaApiForm('facilityCode', event.target.value)}
                />
              </div>
              {/* ✅ NHIA CONFIG PATCH START */}
              <div className="settings-form-row">
                <select
                  value={nhiaApiForm.facilityType}
                  onChange={(event) => updateNhiaApiForm('facilityType', event.target.value)}
                >
                  <option value="Pharmacy">Pharmacy</option>
                  <option value="Hospital">Hospital</option>
                  <option value="Clinic">Clinic</option>
                  <option value="Maternity">Maternity</option>
                  <option value="Chemical Seller">Chemical Seller</option>
                </select>
                <select
                  value={nhiaApiForm.pharmacyFacilityLevel}
                  onChange={(event) => updateNhiaApiForm('pharmacyFacilityLevel', event.target.value)}
                >
                  <option value="">Pharmacy/facility level</option>
                  <option value="P1">P1 - Full pharmacy / higher pharmacy service level</option>
                  <option value="P2">P2 - Restricted or lower pharmacy service level</option>
                  <option value="LCS">LCS - Licensed Chemical Seller</option>
                  <option value="HP">HP - Hospital Pharmacy</option>
                </select>
              </div>
              <div className="settings-form-row">
                <input
                  placeholder="CLAIM-it credential code"
                  value={nhiaApiForm.credentialCode}
                  onChange={(event) => updateNhiaApiForm('credentialCode', event.target.value)}
                />
                <input
                  placeholder="Provider level code"
                  value={nhiaApiForm.providerLevelCode}
                  onChange={(event) => updateNhiaApiForm('providerLevelCode', event.target.value)}
                />
              </div>
              <div className="settings-form-row">
                <input
                  placeholder="License number"
                  value={nhiaApiForm.licenseNumber}
                  onChange={(event) => updateNhiaApiForm('licenseNumber', event.target.value)}
                />
                <input
                  type="date"
                  placeholder="Accreditation expiry date"
                  value={nhiaApiForm.accreditationExpiryDate}
                  onChange={(event) => updateNhiaApiForm('accreditationExpiryDate', event.target.value)}
                />
              </div>
              {/* ✅ NHIA CONFIG PATCH END */}
              <div className="settings-form-row">
                <input
                  placeholder="Provider number"
                  value={nhiaApiForm.providerNumber}
                  onChange={(event) => updateNhiaApiForm('providerNumber', event.target.value)}
                />
                <select
                  value={nhiaApiForm.providerClassLevel}
                  onChange={(event) => updateNhiaApiForm('providerClassLevel', event.target.value)}
                >
                  <option value="">Provider class / level</option>
                  <option value="B1">B1</option>
                  <option value="B2">B2</option>
                  <option value="C">C</option>
                  <option value="D">D</option>
                  <option value="M">M</option>
                  <option value="SM">SM</option>
                </select>
              </div>
              <div className="settings-form-row">
                <select
                  value={nhiaApiForm.providerTypeDescription}
                  onChange={(event) => updateNhiaApiForm('providerTypeDescription', event.target.value)}
                >
                  <option value="">Provider type description</option>
                  <option value="Tertiary care hospital">Tertiary care hospital</option>
                  <option value="Secondary care hospital">Secondary care hospital</option>
                  <option value="Primary care hospital">Primary care hospital</option>
                  <option value="Private Primary Care Hospital">Private Primary Care Hospital</option>
                  <option value="CHAG Primary Care Hospital">CHAG Primary Care Hospital</option>
                  <option value="Health centers (Public, Private, CHAG)">Health centers (Public, Private, CHAG)</option>
                  <option value="Maternity homes">Maternity homes</option>
                  <option value="Private clinics">Private clinics</option>
                  <option value="Dental clinics">Dental clinics</option>
                  <option value="Eye centers">Eye centers</option>
                  <option value="Diagnostic centers">Diagnostic centers</option>
                  <option value="CHPS Compounds">CHPS Compounds</option>
                  <option value="Pharmacy">Pharmacy</option>
                </select>
                <select
                  value={nhiaApiForm.admissionPaymentOption}
                  onChange={(event) => updateNhiaApiForm('admissionPaymentOption', event.target.value)}
                >
                  <option value="nhis_pays_admission">NHIS pays admission</option>
                  <option value="patient_pays_admission">Patient pays admission</option>
                  <option value="not_applicable">Not applicable</option>
                </select>
              </div>
              <div className="settings-form-row">
                <input
                  placeholder="Claims officer name"
                  value={nhiaApiForm.claimsOfficerName}
                  onChange={(event) => updateNhiaApiForm('claimsOfficerName', event.target.value)}
                />
                <div className="signature-upload-field">
                  {nhiaApiForm.claimsOfficerSignatureUrl && (
                    <img
                      src={nhiaApiForm.claimsOfficerSignatureUrl}
                      alt="Claims officer signature preview"
                      className="settings-signature-preview"
                    />
                  )}
                  <label htmlFor="nhiaSignature">Claims officer signature</label>
                  <input
                    id="nhiaSignature"
                    type="file"
                    accept="image/*"
                    onChange={handleNhiaSignatureChange}
                  />
                  {nhiaApiForm.claimsOfficerSignatureUrl && (
                    <button
                      className="btn btn-outline btn-sm"
                      type="button"
                      onClick={() => updateNhiaApiForm('claimsOfficerSignatureUrl', '')}
                    >
                      Remove signature
                    </button>
                  )}
                </div>
              </div>
              <div className="settings-form-row">
                <input
                  placeholder="Submitter ID"
                  value={nhiaApiForm.submitterId}
                  onChange={(event) => updateNhiaApiForm('submitterId', event.target.value)}
                />
                <label className="settings-checkbox-label">
                  <input
                    type="checkbox"
                    checked={nhiaApiForm.claimitValidationEnabled !== false}
                    onChange={(event) => updateNhiaApiForm('claimitValidationEnabled', event.target.checked)}
                  />
                  Allow CLAIM-it validation
                </label>
              </div>
              {/* ✅ NHIA CONFIG PATCH START */}
              <div className="settings-note">
                <strong>CLAIM-it metadata preview</strong>
                <div>facilityName: {claimItPreview.facilityName || 'Not configured'}</div>
                <div>providerID: {claimItPreview.providerID || 'Not configured'}</div>
                <div>providerLevel: {claimItPreview.providerLevel || 'Not configured'}</div>
                <div>providerClassLevel: {claimItPreview.providerClassLevel || 'Not configured'}</div>
                <div>pharmacyFacilityLevel: {claimItPreview.pharmacyFacilityLevel || 'Not configured'}</div>
                <div>credentialCode: {claimItPreview.credentialCode || 'Not configured'}</div>
                <div>licenseNumber: {claimItPreview.licenseNumber || 'Not configured'}</div>
                <div>accreditationExpiryDate: {claimItPreview.accreditationExpiryDate || 'Not configured'}</div>
              </div>
              {/* ✅ NHIA CONFIG PATCH END */}
              <select
                value={nhiaApiForm.apiEnvironment}
                onChange={(event) => updateNhiaApiForm('apiEnvironment', event.target.value)}
              >
                <option value="production">Production</option>
                <option value="sandbox">Sandbox</option>
              </select>
              <input
                placeholder="API base URL"
                value={nhiaApiForm.apiBaseUrl}
                onChange={(event) => updateNhiaApiForm('apiBaseUrl', event.target.value)}
              />
              <div className="settings-form-row">
                <input
                  placeholder="Claim submit endpoint path"
                  value={nhiaApiForm.claimEndpointPath}
                  onChange={(event) => updateNhiaApiForm('claimEndpointPath', event.target.value)}
                />
                <input
                  placeholder="CCC/CC endpoint path"
                  value={nhiaApiForm.ccCodeEndpointPath}
                  onChange={(event) => updateNhiaApiForm('ccCodeEndpointPath', event.target.value)}
                />
              </div>
              <select
                value={nhiaApiForm.exportFormat}
                onChange={(event) => updateNhiaApiForm('exportFormat', event.target.value)}
              >
                <option value="json">Submit JSON payload</option>
                <option value="xml">Submit XML payload</option>
              </select>
              <div className="settings-form-row">
                <input
                  placeholder="Claim status endpoint path"
                  value={nhiaApiForm.claimStatusEndpointPath}
                  onChange={(event) => updateNhiaApiForm('claimStatusEndpointPath', event.target.value)}
                />
                <input
                  placeholder="Member lookup endpoint path"
                  value={nhiaApiForm.memberLookupEndpointPath}
                  onChange={(event) => updateNhiaApiForm('memberLookupEndpointPath', event.target.value)}
                />
              </div>
              <select
                value={nhiaApiForm.credentialMode}
                onChange={(event) => updateNhiaApiForm('credentialMode', event.target.value)}
              >
                <option value="api_key">API key / secret</option>
                <option value="bearer_token">Bearer token</option>
                <option value="basic_auth">Username / password</option>
                <option value="claimit_token">ClaimIt token exchange</option>
                <option value="oauth_client">OAuth/client token</option>
              </select>
              {nhiaApiForm.credentialMode === 'api_key' && (
                <>
                  <div className="settings-form-row">
                    <input
                      placeholder="API key"
                      type="password"
                      value={nhiaApiForm.credentials.apiKey}
                      onChange={(event) => updateNhiaCredential('apiKey', event.target.value)}
                    />
                    <input
                      placeholder="API key header (x-api-key)"
                      value={nhiaApiForm.credentials.headerName}
                      onChange={(event) => updateNhiaCredential('headerName', event.target.value)}
                    />
                  </div>
                  <div className="settings-form-row">
                    <input
                      placeholder="API secret"
                      type="password"
                      value={nhiaApiForm.credentials.apiSecret}
                      onChange={(event) => updateNhiaCredential('apiSecret', event.target.value)}
                    />
                    <input
                      placeholder="Secret header (x-api-secret)"
                      value={nhiaApiForm.credentials.secretHeaderName}
                      onChange={(event) => updateNhiaCredential('secretHeaderName', event.target.value)}
                    />
                  </div>
                  <div className="settings-form-row">
                    <input
                      placeholder="Username"
                      value={nhiaApiForm.credentials.username}
                      onChange={(event) => updateNhiaCredential('username', event.target.value)}
                    />
                    <input
                      placeholder="Password"
                      type="password"
                      value={nhiaApiForm.credentials.password}
                      onChange={(event) => updateNhiaCredential('password', event.target.value)}
                    />
                  </div>
                </>
              )}
              {nhiaApiForm.credentialMode === 'bearer_token' && (
                <input
                  placeholder="Bearer token"
                  type="password"
                  value={nhiaApiForm.credentials.apiKey || nhiaApiForm.credentials.token}
                  onChange={(event) => {
                    updateNhiaCredential('apiKey', event.target.value)
                    updateNhiaCredential('token', event.target.value)
                  }}
                />
              )}
              {nhiaApiForm.credentialMode === 'basic_auth' && (
                <div className="settings-form-row">
                  <input
                    placeholder="Username"
                    value={nhiaApiForm.credentials.username}
                    onChange={(event) => updateNhiaCredential('username', event.target.value)}
                  />
                  <input
                    placeholder="Password"
                    type="password"
                    value={nhiaApiForm.credentials.password}
                    onChange={(event) => updateNhiaCredential('password', event.target.value)}
                  />
                </div>
              )}
              {nhiaApiForm.credentialMode === 'claimit_token' && (
                <>
                  <div className="settings-form-row">
                    <input
                      placeholder="ClaimIt username"
                      value={nhiaApiForm.credentials.username}
                      onChange={(event) => updateNhiaCredential('username', event.target.value)}
                    />
                    <input
                      placeholder="ClaimIt password"
                      type="password"
                      value={nhiaApiForm.credentials.password}
                      onChange={(event) => updateNhiaCredential('password', event.target.value)}
                    />
                  </div>
                  <input
                    placeholder="Token endpoint path (/token)"
                    value={nhiaApiForm.credentials.tokenEndpointPath}
                    onChange={(event) => updateNhiaCredential('tokenEndpointPath', event.target.value)}
                  />
                </>
              )}
              {nhiaApiForm.credentialMode === 'oauth_client' && (
                <>
                  <input
                    placeholder="OAuth access token"
                    type="password"
                    value={nhiaApiForm.credentials.token || nhiaApiForm.credentials.apiKey}
                    onChange={(event) => {
                      updateNhiaCredential('token', event.target.value)
                      updateNhiaCredential('apiKey', event.target.value)
                    }}
                  />
                  <div className="settings-form-row">
                    <input
                      placeholder="Client ID"
                      value={nhiaApiForm.credentials.clientId}
                      onChange={(event) => updateNhiaCredential('clientId', event.target.value)}
                    />
                    <input
                      placeholder="Client secret"
                      type="password"
                      value={nhiaApiForm.credentials.clientSecret}
                      onChange={(event) => updateNhiaCredential('clientSecret', event.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="settings-save-bar">
                <span>Leave secret fields blank to keep the saved values.</span>
                <button className="btn btn-primary" type="submit" disabled={savingNhiaApi}>
                  {savingNhiaApi ? 'Saving...' : 'Save NHIA API'}
                </button>
              </div>
            </form>
          </div>
        )}

        {isAdmin && (
          <div className="settings-card branch-card">
            <div className="card-icon">
              <GitBranch size={24} />
            </div>
            <h3>Branch Locations</h3>
            <p className="settings-note">
              Manage all physical locations. Staff can be assigned to a specific branch at onboarding.
            </p>
            <div className="branch-list">
              {branches.map((br) => (
                <div key={br.id} className={`branch-row${!br.is_active ? ' branch-inactive' : ''}`}>
                  {editingBranchId === br.id ? (
                    <form onSubmit={(e) => handleSaveBranch(e, br.id)} className="branch-edit-form">
                      <div className="settings-form-row">
                        <input
                          placeholder="Branch name *"
                          value={editBranchForm.name}
                          onChange={(e) => setEditBranchForm({ ...editBranchForm, name: e.target.value })}
                          required
                        />
                        <input
                          placeholder="Code (e.g. EAST)"
                          value={editBranchForm.code}
                          onChange={(e) => setEditBranchForm({ ...editBranchForm, code: e.target.value })}
                        />
                      </div>
                      <div className="settings-form-row">
                        <input
                          placeholder="Phone"
                          value={editBranchForm.phone}
                          onChange={(e) => setEditBranchForm({ ...editBranchForm, phone: e.target.value })}
                        />
                        <input
                          type="email"
                          placeholder="Email"
                          value={editBranchForm.email}
                          onChange={(e) => setEditBranchForm({ ...editBranchForm, email: e.target.value })}
                        />
                      </div>
                      <input
                        placeholder="Address"
                        value={editBranchForm.address}
                        onChange={(e) => setEditBranchForm({ ...editBranchForm, address: e.target.value })}
                      />
                      <div className="settings-form-row">
                        <input
                          placeholder="City"
                          value={editBranchForm.city}
                          onChange={(e) => setEditBranchForm({ ...editBranchForm, city: e.target.value })}
                        />
                        <GhanaRegionSelect
                          value={editBranchForm.region}
                          onChange={(e) => setEditBranchForm({ ...editBranchForm, region: e.target.value })}
                        />
                      </div>
                      <div className="branch-form-actions">
                        <button type="submit" className="btn btn-primary btn-sm" disabled={savingBranch}>
                          {savingBranch ? 'Saving...' : 'Save'}
                        </button>
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditingBranchId(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="branch-info">
                      <div className="branch-header">
                        <span className="branch-name">{br.name}</span>
                        {br.is_main && <span className="branch-badge-main">Main</span>}
                        {!br.is_active && <span className="branch-badge-inactive">Inactive</span>}
                      </div>
                      {(br.code || br.city) && (
                        <div className="branch-meta">
                          {br.code && <span>Code: {br.code}</span>}
                          {br.city && <span>{br.city}{br.region ? `, ${br.region}` : ''}</span>}
                        </div>
                      )}
                      <div className="branch-actions">
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => openEditBranch(br)}>
                          Edit
                        </button>
                        {!br.is_main && br.is_active && (
                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            onClick={() => handleDeactivateBranch(br.id)}
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {branches.length === 0 && <p className="branch-empty">No branches yet.</p>}
            </div>

            {!canUseMultiBranch && activeBranches.length >= 1 && (
              <p className="settings-note">
                Multi-branch is locked for this pharmacy. The main branch can be managed, but
                new branches require the Multi-branch module.
              </p>
            )}

            {showBranchForm ? (
              <form className="settings-form branch-add-form" onSubmit={handleCreateBranch}>
                <div className="settings-form-row">
                  <input
                    placeholder="Branch name *"
                    value={branchForm.name}
                    onChange={(e) => setBranchForm({ ...branchForm, name: e.target.value })}
                    required
                    disabled={creatingBranch}
                  />
                  <input
                    placeholder="Code (e.g. EAST)"
                    value={branchForm.code}
                    onChange={(e) => setBranchForm({ ...branchForm, code: e.target.value })}
                    disabled={creatingBranch}
                  />
                </div>
                <div className="settings-form-row">
                  <input
                    placeholder="Phone"
                    value={branchForm.phone}
                    onChange={(e) => setBranchForm({ ...branchForm, phone: e.target.value })}
                    disabled={creatingBranch}
                  />
                  <input
                    type="email"
                    placeholder="Email"
                    value={branchForm.email}
                    onChange={(e) => setBranchForm({ ...branchForm, email: e.target.value })}
                    disabled={creatingBranch}
                  />
                </div>
                <input
                  placeholder="Address"
                  value={branchForm.address}
                  onChange={(e) => setBranchForm({ ...branchForm, address: e.target.value })}
                  disabled={creatingBranch}
                />
                <div className="settings-form-row">
                  <input
                    placeholder="City"
                    value={branchForm.city}
                    onChange={(e) => setBranchForm({ ...branchForm, city: e.target.value })}
                    disabled={creatingBranch}
                  />
                  <GhanaRegionSelect
                    value={branchForm.region}
                    onChange={(e) => setBranchForm({ ...branchForm, region: e.target.value })}
                    disabled={creatingBranch}
                  />
                </div>
                <div className="branch-form-actions">
                  <button type="submit" className="btn btn-primary" disabled={creatingBranch}>
                    {creatingBranch ? 'Creating...' : 'Create Branch'}
                  </button>
                  <button type="button" className="btn btn-outline" onClick={() => setShowBranchForm(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowBranchForm(true)}
                disabled={!canUseMultiBranch && activeBranches.length >= 1}
              >
                <Plus size={14} />
                Add Branch
              </button>
            )}
          </div>
        )}

        {isAdmin && (
          <div className="settings-card">
            <div className="card-icon">
              <UserPlus size={24} />
            </div>
            <h3>Staff Onboarding</h3>
            <p className="settings-note">
              Create staff logins without leaving the app. New staff can sign
              in immediately with the temporary password below.
            </p>
            {tierLimits.maxUsers !== Infinity && (
              <p className={`settings-user-limit ${atUserLimit ? 'at-limit' : ''}`}>
                {users.length} / {tierLimits.maxUsers} users used
                {atUserLimit && ' — upgrade to add more'}
              </p>
            )}
            <UpgradeGate locked={atUserLimit} feature={`More than ${tierLimits.maxUsers} users`} requiredTier="pro">
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
                    setStaffForm({
                      ...staffForm,
                      role: event.target.value,
                      canRefund: false,
                      canManageInventory: false,
                      canViewReports: false,
                      canManageClaims: event.target.value === 'claims_officer',
                    })
                  }
                  disabled={creatingStaff}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              {!['admin', 'pharmacist', 'claims_officer'].includes(staffForm.role) && (
                <div className="settings-privileges-group">
                  <p className="settings-helper">Privileges</p>
                  <label className="settings-checkbox-label">
                    <input
                      type="checkbox"
                      checked={staffForm.canRefund}
                      onChange={(event) =>
                        setStaffForm({ ...staffForm, canRefund: event.target.checked })
                      }
                      disabled={creatingStaff}
                    />
                    Process refunds
                  </label>
                  <label className="settings-checkbox-label">
                    <input
                      type="checkbox"
                      checked={staffForm.canManageInventory}
                      onChange={(event) =>
                        setStaffForm({ ...staffForm, canManageInventory: event.target.checked })
                      }
                      disabled={creatingStaff}
                    />
                    Manage inventory
                  </label>
                  <label className="settings-checkbox-label">
                    <input
                      type="checkbox"
                      checked={staffForm.canViewReports}
                      onChange={(event) =>
                        setStaffForm({ ...staffForm, canViewReports: event.target.checked })
                      }
                      disabled={creatingStaff}
                    />
                    View reports
                  </label>
                  <label className="settings-checkbox-label">
                    <input
                      type="checkbox"
                      checked={staffForm.canManageClaims}
                      onChange={(event) =>
                        setStaffForm({ ...staffForm, canManageClaims: event.target.checked })
                      }
                      disabled={creatingStaff}
                    />
                    Submit insurance claims
                  </label>
                </div>
              )}
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
              {activeBranches.length > 1 ? (
                <select
                  value={staffForm.branchId}
                  onChange={(event) => setStaffForm({ ...staffForm, branchId: event.target.value })}
                  disabled={creatingStaff}
                  required
                >
                  <option value="">Select branch</option>
                  {activeBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.code ? ` (${b.code})` : ''}
                    </option>
                  ))}
                </select>
              ) : singleActiveBranch ? (
                <p className="settings-helper">
                  Branch: {singleActiveBranch.name}{singleActiveBranch.code ? ` (${singleActiveBranch.code})` : ''}
                </p>
              ) : null}
              <p className="settings-helper">
                Share the temporary password securely, then ask the staff member to use the
                password reset link after first sign-in.
              </p>
              <button className="btn btn-primary" type="submit" disabled={creatingStaff}>
                {creatingStaff ? 'Creating Account...' : 'Create Staff Account'}
              </button>
            </form>
            </UpgradeGate>
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
                      <small>{getRoleLabel(row.role)}</small>
                      <span className={`user-status-badge ${row.branch_id ? 'active' : 'inactive'}`}>
                        Branch: {row.branches?.name || 'Not assigned'}
                      </span>
                      {row.role === 'admin' ? (
                        <span className="user-status-badge active">Refunds: Admin</span>
                      ) : (
                        <span
                          className={`user-status-badge ${row.can_refund ? 'active' : 'inactive'}`}
                        >
                          Refunds: {row.can_refund ? 'Allowed' : 'Not allowed'}
                        </span>
                      )}
                      <span
                        className={`user-status-badge ${row.is_active ? 'active' : 'inactive'}`}
                      >
                        {row.is_active ? 'Active' : 'Disabled'}
                      </span>
                    </div>
                  </div>
                  <div className="user-actions">
                    {branches.length > 0 && (
                      <select
                        className="user-branch-select"
                        value={row.branch_id || ''}
                        onChange={(event) => handleUserBranchChange(row, event.target.value)}
                        disabled={branchUpdatingId === row.id}
                      >
                        <option value="">Select branch</option>
                        {branches.filter((b) => b.is_active).map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}{b.code ? ` (${b.code})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    {row.role !== 'admin' && (
                      <button
                        className={`btn ${row.can_refund ? 'btn-outline' : 'btn-primary'}`}
                        onClick={() => toggleRefundPermission(row)}
                        type="button"
                        disabled={refundPermissionUpdatingId === row.id}
                      >
                        {refundPermissionUpdatingId === row.id
                          ? 'Updating...'
                          : row.can_refund
                            ? 'Remove Refund Access'
                            : 'Allow Refunds'}
                      </button>
                    )}
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
        <p className="about-version">Version 1.0.0</p>
        <p className="about-summary">
          HealthFlow Pharmacy brings inventory, sales, claims, staff, and tenant operations
          together in one streamlined workspace.
        </p>
        <p className="copyright">Copyright 2026 HealthFlow Pharmacy. All rights reserved.</p>
      </div>
    </div>
  )
}

export default Settings
