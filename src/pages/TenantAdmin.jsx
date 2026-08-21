import { Fragment, useCallback, useEffect, useState } from 'react'
import { getRoleLabel } from '../utils/roleLabels'
import { Building2, GitBranch, Plus, Users, ChevronDown, ChevronUp, Eye, Pencil, Trash2 } from 'lucide-react'
import { useNotification } from '../context/NotificationContext'
import GhanaRegionSelect from '../components/GhanaRegionSelect'
import PasswordVisibilityCheckbox from '../components/PasswordVisibilityCheckbox'
import { useSessionStorageState } from '../hooks/useSessionStorageState'
import { formatAppDate } from '../utils/date'
import { normalizeGhanaRegion } from '../utils/ghanaRegions'
import { ROLE_OPTIONS, normalizeAssignedRoles } from '../utils/roles'
import {
  getTenantAdminDashboard,
  createPharmacyTenant,
  updateOrganizationStatus,
  updateSubscriptionTier,
  updateOrganizationDetails,
  updateOrganizationUser,
  deletePharmacyTenant,
  getOrganizationUsers,
  checkSubdomainAvailable,
} from '../services/tenantAdminService'
import { readLogoFileAsDataUrl } from '../utils/imageUpload'
import { requestAppPrompt } from '../utils/appDialog'
import './TenantAdmin.css'

const blankPharmacy = {
  organizationType: 'pharmacy',
  name: '',
  subdomain: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  region: '',
  logoUrl: '',
  slogan: '',
  licenseNumber: '',
  subscriptionTier: 'basic',
  planCode: 'starter',
  billingStatus: 'trial',
  supportLevel: 'standard',
  canUseClaims: false,
  canUsePurchases: false,
  canUseNhis: false,
  canUseNhisTopups: false,
  nhisTopUpPolicy: 'not_allowed',
  canUseAccounting: false,
  canUseMultiBranch: false,
  canUseOfflineInstaller: false,
  nextPaymentDueAt: '',
  billingNotes: '',
}

const blankAdmin = {
  fullName: '',
  email: '',
  phone: '',
  temporaryPassword: '',
}

const TENANT_ADMIN_EXPANDED_ORG_KEY = 'healthflow.tenantAdmin.expandedOrgId'

const formatPlanCode = (value) => {
  const normalized = String(value || 'starter')
  if (normalized === 'professional') return 'Professional'
  if (normalized === 'premium') return 'Premium'
  return 'Starter'
}

const formatBillingStatus = (value) =>
  String(value || 'trial')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())

const formatOrganizationType = (value) => {
  const normalized = String(value || 'pharmacy')
  if (normalized === 'hospital') return 'Hospital'
  if (normalized === 'chemical_shop') return 'Chemical Shop'
  return 'Pharmacy'
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
  const [showTemporaryPassword, setShowTemporaryPassword] = useState(false)
  const [creating, setCreating] = useState(false)
  const [subdomainOk, setSubdomainOk] = useState(null)
  const [checkingSubdomain, setCheckingSubdomain] = useState(false)

  // Expanded org detail
  const [expandedOrgId, setExpandedOrgId] = useSessionStorageState(
    TENANT_ADMIN_EXPANDED_ORG_KEY,
    null,
    {
      validate: (value) => value === null || typeof value === 'string',
    }
  )
  const [orgUsers, setOrgUsers] = useState({})

  // Edit pharmacy modal
  const [editOrg, setEditOrg] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [saving, setSaving] = useState(false)

  // Edit user modal
  const [editUser, setEditUser] = useState(null)
  const [editUserForm, setEditUserForm] = useState({})
  const [savingUser, setSavingUser] = useState(false)
  const [deletingOrgId, setDeletingOrgId] = useState('')

  useEffect(() => {
    void load()
  }, [])

  const loadOrganizationUsers = useCallback(async (orgId) => {
    if (!orgId) {
      return
    }

    try {
      const users = await getOrganizationUsers(orgId)
      setOrgUsers((prev) => ({ ...prev, [orgId]: users }))
    } catch {
      // silently fail
    }
  }, [])

  const load = async () => {
    try {
      setLoading(true)
      setError('')
      const dashboard = await getTenantAdminDashboard()
      setOrgs(dashboard.organizations)
      setUserCounts(dashboard.userCounts)
      setBranchCounts(dashboard.branchCounts)
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
    const facilityLabel = formatOrganizationType(pharmacy.organizationType)
    if (!pharmacy.name.trim()) return setError(`${facilityLabel} name is required`)
    if (!pharmacy.subdomain.trim() || pharmacy.subdomain.length < 3) return setError('Subdomain must be at least 3 characters')
    if (subdomainOk === false) return setError('That subdomain is already taken')
    if (!admin.email.trim()) return setError('Admin email is required')
    if (!admin.temporaryPassword || admin.temporaryPassword.length < 8) return setError('Temporary password must be at least 8 characters')
    if (!admin.fullName.trim()) return setError('Admin full name is required')

    setCreating(true)
    setError('')
    try {
      await createPharmacyTenant({ pharmacy, admin })
      notify(`${facilityLabel} "${pharmacy.name}" created successfully!`, 'success', 5000)
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
      await loadOrganizationUsers(orgId)
    }
  }

  useEffect(() => {
    if (!expandedOrgId || orgs.length === 0) {
      return
    }

    if (!orgs.some((org) => org.id === expandedOrgId)) {
      setExpandedOrgId(null)
      return
    }

    if (!orgUsers[expandedOrgId]) {
      void loadOrganizationUsers(expandedOrgId)
    }
  }, [expandedOrgId, loadOrganizationUsers, orgUsers, orgs, setExpandedOrgId])

  const openEdit = (org) => {
    setEditOrg(org)
    setEditForm({
      name: org.name || '',
      organizationType: org.organization_type || 'pharmacy',
      phone: org.phone || '',
      email: org.email || '',
      address: org.address || '',
      city: org.city || '',
      region: normalizeGhanaRegion(org.region),
      logoUrl: org.logo_url || '',
      slogan: org.slogan || '',
      licenseNumber: org.license_number || '',
      status: org.status || 'trial',
      subscriptionTier: org.subscription_tier || 'basic',
      planCode: org.plan_code || 'starter',
      billingStatus: org.billing_status || org.status || 'trial',
      supportLevel: org.support_level || 'standard',
      canUseClaims: Boolean(org.can_use_claims),
      canUsePurchases: Boolean(org.can_use_purchases),
      canUseNhis: Boolean(org.can_use_nhis),
      canUseNhisTopups: Boolean(org.can_use_nhis_topups),
      nhisTopUpPolicy: org.nhis_top_up_policy || (org.can_use_nhis_topups ? 'allowed' : 'not_allowed'),
      canUseAccounting: Boolean(org.can_use_accounting),
      canUseMultiBranch: Boolean(org.can_use_multi_branch),
      canUseOfflineInstaller: Boolean(org.can_use_offline_installer),
      billingNotes: org.billing_notes || '',
      lastPaymentAt: org.last_payment_at ? org.last_payment_at.split('T')[0] : '',
      nextPaymentDueAt: org.next_payment_due_at ? org.next_payment_due_at.split('T')[0] : '',
      trialEndsAt: org.trial_ends_at ? org.trial_ends_at.split('T')[0] : '',
      subscriptionEndsAt: org.subscription_ends_at ? org.subscription_ends_at.split('T')[0] : '',
    })
  }

  const closeEdit = () => {
    setEditOrg(null)
    setEditForm({})
  }

  const openEditUser = (user) => {
    const primaryRole = user.role || 'pharmacist'
    setEditUser(user)
    setEditUserForm({
      fullName: user.full_name || '',
      email: user.email || '',
      role: primaryRole,
      assignedRoles: normalizeAssignedRoles(user.assigned_roles, primaryRole),
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
    if (!editForm.name.trim()) return setError(`${formatOrganizationType(editForm.organizationType)} name is required`)
    setSaving(true)
    setError('')
    try {
      const updatedOrganization = await updateOrganizationDetails(editOrg.id, {
        ...editForm,
        trialEndsAt: editForm.trialEndsAt ? new Date(editForm.trialEndsAt).toISOString() : null,
        subscriptionEndsAt: editForm.subscriptionEndsAt ? new Date(editForm.subscriptionEndsAt).toISOString() : null,
        lastPaymentAt: editForm.lastPaymentAt ? new Date(editForm.lastPaymentAt).toISOString() : null,
        nextPaymentDueAt: editForm.nextPaymentDueAt ? new Date(editForm.nextPaymentDueAt).toISOString() : null,
      })
      if (
        Boolean(updatedOrganization?.can_use_claims) !== Boolean(editForm.canUseClaims) ||
        Boolean(updatedOrganization?.can_use_purchases) !== Boolean(editForm.canUsePurchases) ||
        Boolean(updatedOrganization?.can_use_nhis) !== Boolean(editForm.canUseNhis) ||
        Boolean(updatedOrganization?.can_use_nhis_topups) !==
          Boolean(editForm.canUseNhis && editForm.canUseNhisTopups) ||
        Boolean(updatedOrganization?.can_use_accounting) !== Boolean(editForm.canUseAccounting) ||
        Boolean(updatedOrganization?.can_use_multi_branch) !== Boolean(editForm.canUseMultiBranch) ||
        Boolean(updatedOrganization?.can_use_offline_installer) !== Boolean(editForm.canUseOfflineInstaller)
      ) {
        throw new Error('Module privileges were not saved. Deploy the latest tenant-signup function and try again.')
      }
      notify(`${editForm.name} updated successfully`, 'success')
      closeEdit()
      await load()
    } catch (err) {
      setError(err.message || 'Failed to save changes')
    } finally {
      setSaving(false)
    }
  }

  const handleDeletePharmacy = async (org) => {
    const facilityLabel = formatOrganizationType(org.organization_type).toLowerCase()
    const confirmation = await requestAppPrompt({
      title: `Permanently delete "${org.name}"?`,
      message: `Type the facility name exactly to confirm deletion of this ${facilityLabel} and its data.`,
      label: 'Facility name',
      placeholder: org.name,
      required: true,
      warning: 'This action is permanent and cannot be undone.',
      confirmText: 'delete permanently',
    })

    if (confirmation === null) {
      return
    }

    if (confirmation.trim() !== org.name) {
      notify('Facility name did not match. Delete cancelled.', 'warning')
      return
    }

    try {
      setDeletingOrgId(org.id)
      setError('')
      const result = await deletePharmacyTenant(org.id, confirmation)
      notify(
        `Deleted ${org.name}. Removed ${result.deletedAuthUsers || 0} auth account(s).`,
        'success',
        6000
      )
      if (expandedOrgId === org.id) {
        setExpandedOrgId(null)
      }
      await load()
    } catch (err) {
      setError(err.message || 'Failed to delete facility')
      notify(err.message || 'Failed to delete facility', 'error')
    } finally {
      setDeletingOrgId('')
    }
  }

  const handleCreateLogoChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setError('')
      const logoUrl = await readLogoFileAsDataUrl(file)
      setPharmacy((current) => ({ ...current, logoUrl }))
    } catch (logoError) {
      setError(logoError.message || 'Unable to upload logo.')
    } finally {
      event.target.value = ''
    }
  }

  const handleEditLogoChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setError('')
      const logoUrl = await readLogoFileAsDataUrl(file)
      setEditForm((current) => ({ ...current, logoUrl }))
    } catch (logoError) {
      setError(logoError.message || 'Unable to upload logo.')
    } finally {
      event.target.value = ''
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
          <p>Manage pharmacies, hospital pharmacies, clinics, and hospitals on the HealthFlow platform</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={16} />
          {showCreate ? 'Cancel' : 'Add Facility'}
        </button>
      </div>

      {error && <div className="tenant-alert">{error}</div>}

      {/* Create Form */}
      {showCreate && (
        <div className="tenant-create-card">
          <h3>Register New Facility</h3>
          <form onSubmit={handleCreate}>
            <div className="tenant-form-section">
              <h4>Facility Details</h4>
              <div className="tenant-form-grid">
                <div className="tenant-form-group">
                  <label>Facility Type *</label>
                  <select
                    value={pharmacy.organizationType}
                    onChange={(e) => setPharmacy({ ...pharmacy, organizationType: e.target.value })}
                    required
                  >
                    <option value="pharmacy">Community Pharmacy</option>
                    <option value="hospital">Hospital / Clinic</option>
                    <option value="chemical_shop">Chemical Shop</option>
                  </select>
                </div>
                <div className="tenant-form-group">
                  <label>{formatOrganizationType(pharmacy.organizationType)} Name *</label>
                  <input
                    placeholder={pharmacy.organizationType === 'hospital' ? 'ABC Hospital' : 'ABC Community Pharmacy'}
                    value={pharmacy.name}
                    onChange={(e) => setPharmacy({ ...pharmacy, name: e.target.value })}
                    required
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Subdomain *</label>
                  <div className="subdomain-row">
                    <input
                      placeholder="abc-facility"
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
                    placeholder="info@facility.com"
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
                  <GhanaRegionSelect
                    value={pharmacy.region}
                    onChange={(e) => setPharmacy({ ...pharmacy, region: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group">
                  <label>{formatOrganizationType(pharmacy.organizationType)} Slogan</label>
                  <input
                    placeholder={pharmacy.organizationType === 'hospital' ? 'Smart Care. Better Health.' : 'Connected Pharmacy. Better Health.'}
                    value={pharmacy.slogan}
                    onChange={(e) => setPharmacy({ ...pharmacy, slogan: e.target.value })}
                    maxLength={120}
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
                  <label>{formatOrganizationType(pharmacy.organizationType)} Logo</label>
                  <div className="tenant-logo-upload-card">
                    {pharmacy.logoUrl ? (
                      <img src={pharmacy.logoUrl} alt={`${formatOrganizationType(pharmacy.organizationType)} logo preview`} className="tenant-logo-preview" />
                    ) : (
                      <div className="tenant-logo-placeholder" aria-hidden="true">
                        {pharmacy.name.trim().charAt(0).toUpperCase() || '+'}
                      </div>
                    )}
                    <div className="tenant-logo-upload-copy">
                      <strong>{pharmacy.logoUrl ? 'Logo selected' : `Add ${formatOrganizationType(pharmacy.organizationType).toLowerCase()} logo`}</strong>
                      <span>Shown on dashboard and receipts. Max 750KB.</span>
                      <input type="file" accept="image/*" onChange={handleCreateLogoChange} />
                    </div>
                  </div>
                  {pharmacy.logoUrl && (
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setPharmacy({ ...pharmacy, logoUrl: '' })}
                    >
                      Remove Logo
                    </button>
                  )}
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
                <div className="tenant-form-group">
                  <label>Commercial Plan</label>
                  <select
                    value={pharmacy.planCode}
                    onChange={(e) => setPharmacy({ ...pharmacy, planCode: e.target.value })}
                  >
                    <option value="starter">Starter</option>
                    <option value="professional">Professional</option>
                    <option value="premium">Premium</option>
                  </select>
                </div>
                <div className="tenant-form-group">
                  <label>Billing Status</label>
                  <select
                    value={pharmacy.billingStatus}
                    onChange={(e) => setPharmacy({ ...pharmacy, billingStatus: e.target.value })}
                  >
                    <option value="trial">Trial</option>
                    <option value="active">Active</option>
                    <option value="past_due">Past due</option>
                    <option value="suspended">Suspended</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
                <div className="tenant-form-group">
                  <label>Support Level</label>
                  <select
                    value={pharmacy.supportLevel}
                    onChange={(e) => setPharmacy({ ...pharmacy, supportLevel: e.target.value })}
                  >
                    <option value="standard">Standard</option>
                    <option value="priority">Priority</option>
                    <option value="premium">Premium</option>
                  </select>
                </div>
                <div className="tenant-form-group">
                  <label>Next Payment Due</label>
                  <input
                    type="date"
                    value={pharmacy.nextPaymentDueAt}
                    onChange={(e) => setPharmacy({ ...pharmacy, nextPaymentDueAt: e.target.value })}
                  />
                </div>
                <div className="tenant-form-group">
                  <label>Module Privileges</label>
                  <label className="tenant-checkbox-label">
                    <input
                      type="checkbox"
                      checked={pharmacy.canUseClaims}
                      onChange={(e) => setPharmacy({ ...pharmacy, canUseClaims: e.target.checked })}
                    />
                    Claims
                  </label>
                  <label className="tenant-checkbox-label">
                    <input
                      type="checkbox"
                      checked={pharmacy.canUsePurchases}
                      onChange={(e) => setPharmacy({ ...pharmacy, canUsePurchases: e.target.checked })}
                    />
                    Purchases
                  </label>
                  <label className="tenant-checkbox-label">
                    <input
                      type="checkbox"
                      checked={pharmacy.canUseNhis}
                      onChange={(e) =>
                        setPharmacy({
                          ...pharmacy,
                          canUseNhis: e.target.checked,
                          canUseNhisTopups: e.target.checked ? pharmacy.canUseNhisTopups : false,
                        })
                      }
                    />
                    NHIS
                  </label>
                  <label className="tenant-checkbox-label">
                    <input
                      type="checkbox"
                      checked={pharmacy.canUseNhis && pharmacy.canUseNhisTopups}
                      disabled={!pharmacy.canUseNhis}
                      onChange={(e) => setPharmacy({ ...pharmacy, canUseNhisTopups: e.target.checked })}
                    />
                    NHIS top-ups
                  </label>
                  <label className="tenant-checkbox-label">
                    NHIS top-up policy
                    <select
                      value={pharmacy.nhisTopUpPolicy}
                      disabled={!pharmacy.canUseNhis}
                      onChange={(e) => setPharmacy({ ...pharmacy, nhisTopUpPolicy: e.target.value })}
                    >
                      <option value="not_allowed">Not allowed</option>
                      <option value="allowed">Allowed</option>
                      <option value="required_when_nhis_below_selling_value">Required when NHIS is lower</option>
                    </select>
                  </label>
                  <label className="tenant-checkbox-label">
                    <input
                      type="checkbox"
                      checked={pharmacy.canUseAccounting}
                      onChange={(e) => setPharmacy({ ...pharmacy, canUseAccounting: e.target.checked })}
                    />
                    Accounting
                  </label>
                  <label className="tenant-checkbox-label">
                    <input
                      type="checkbox"
                      checked={pharmacy.canUseMultiBranch}
                      onChange={(e) => setPharmacy({ ...pharmacy, canUseMultiBranch: e.target.checked })}
                    />
                    Multi-branch
                  </label>
                  <label className="tenant-checkbox-label">
                    <input
                      type="checkbox"
                      checked={pharmacy.canUseOfflineInstaller}
                      onChange={(e) => setPharmacy({ ...pharmacy, canUseOfflineInstaller: e.target.checked })}
                    />
                    Offline installer downloads
                  </label>
                </div>
                <div className="tenant-form-group full-width">
                  <label>Billing Notes</label>
                  <textarea
                    rows="3"
                    value={pharmacy.billingNotes}
                    onChange={(e) => setPharmacy({ ...pharmacy, billingNotes: e.target.value })}
                    placeholder="Payment method, onboarding notes, support terms..."
                  />
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
                    type={showTemporaryPassword ? 'text' : 'password'}
                    minLength={8}
                    placeholder="Min 8 characters"
                    value={admin.temporaryPassword}
                    onChange={(e) => setAdmin({ ...admin, temporaryPassword: e.target.value })}
                    required
                  />
                  <PasswordVisibilityCheckbox
                    id="tenant-admin-temporary-password-visibility"
                    visible={showTemporaryPassword}
                    onChange={setShowTemporaryPassword}
                  />
                </div>
              </div>
              <p className="tenant-helper">Share the temporary password securely. The admin should change it on first login.</p>
            </div>

            <div className="tenant-form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating...' : `Create ${formatOrganizationType(pharmacy.organizationType)}`}
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
            All Facilities ({orgs.length})
          </h3>
        </div>

        {orgs.length === 0 ? (
          <div className="tenant-empty">No facilities registered yet.</div>
        ) : (
          <div className="tenant-table-wrap">
            <table className="tenant-table">
              <thead>
                <tr>
                  <th>Facility</th>
                  <th>Type</th>
                  <th>Subdomain</th>
                  <th>Status</th>
                  <th>Tier</th>
                  <th>Plan</th>
                  <th>Billing</th>
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
                      <td>{formatOrganizationType(org.organization_type)}</td>
                      <td>{formatPlanCode(org.plan_code)}</td>
                      <td>
                        <span className={`status-pill status-${org.billing_status || 'trial'}`}>
                          {formatBillingStatus(org.billing_status)}
                        </span>
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
                          {formatAppDate(org.created_at)}
                        </span>
                      </td>
                      <td>
                        <div className="table-actions">
                          <button
                            className="btn-icon"
                            title="Edit facility"
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
                          <button
                            className="btn-icon danger"
                            title="Delete facility"
                            onClick={() => void handleDeletePharmacy(org)}
                            disabled={deletingOrgId === org.id}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* Expanded users row */}
                    {expandedOrgId === org.id && (
                      <tr className="users-expand-row">
                        <td colSpan={11}>
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
                                        <td>
                                          <div className="tenant-user-role-stack">
                                            <span className={`role-badge role-${u.role}`}>{getRoleLabel(u.role)}</span>
                                            {normalizeAssignedRoles(u.assigned_roles, u.role)
                                              .filter((assignedRole) => assignedRole !== u.role)
                                              .map((assignedRole) => (
                                                <span className="role-badge role-badge--secondary" key={assignedRole}>
                                                  {getRoleLabel(assignedRole)}
                                                </span>
                                              ))}
                                          </div>
                                        </td>
                                        <td>
                                          <span className={`active-badge ${u.is_active ? 'active' : 'inactive'}`}>
                                            {u.is_active ? 'Active' : 'Inactive'}
                                          </span>
                                        </td>
                                        <td>{formatAppDate(u.created_at)}</td>
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
                      onChange={(e) => {
                        const nextRole = e.target.value
                        setEditUserForm({
                          ...editUserForm,
                          role: nextRole,
                          assignedRoles: normalizeAssignedRoles(editUserForm.assignedRoles, nextRole),
                        })
                      }}
                    >
                      {ROLE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
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
                <div className="tenant-form-group full-width tenant-assigned-roles-group">
                  <label>Assigned roles</label>
                  <div className="tenant-role-options">
                    {ROLE_OPTIONS.map((option) => (
                      <label className="tenant-role-checkbox" key={option.value}>
                        <input
                          type="checkbox"
                          checked={normalizeAssignedRoles(editUserForm.assignedRoles, editUserForm.role).includes(option.value)}
                          onChange={(e) => {
                            const currentRoles = normalizeAssignedRoles(editUserForm.assignedRoles, editUserForm.role)
                            setEditUserForm({
                              ...editUserForm,
                              assignedRoles: e.target.checked
                                ? normalizeAssignedRoles([...currentRoles, option.value], editUserForm.role)
                                : currentRoles.filter((assignedRole) =>
                                    assignedRole !== option.value || assignedRole === editUserForm.role
                                  ),
                            })
                          }}
                          disabled={option.value === editUserForm.role}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="tenant-helper-text">
                    The primary role is selected above. Tick extra roles to let staff switch active role after login.
                  </p>
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

      {/* Edit Facility Modal */}
      {editOrg && (
        <div className="modal-backdrop" onClick={closeEdit}>
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h3>Edit Facility</h3>
              <button type="button" className="modal-close" onClick={closeEdit}>
                x
              </button>
            </div>

            {error && <div className="tenant-alert">{error}</div>}

            <form onSubmit={handleSaveEdit} className="edit-modal-body">
              <div className="tenant-form-section">
                <h4>Facility Details</h4>
                <div className="tenant-form-grid">
                  <div className="tenant-form-group">
                    <label>Facility Type *</label>
                    <select
                      value={editForm.organizationType}
                      onChange={(e) => setEditForm({ ...editForm, organizationType: e.target.value })}
                      required
                    >
                      <option value="pharmacy">Community Pharmacy</option>
                      <option value="hospital">Hospital / Clinic</option>
                      <option value="chemical_shop">Chemical Shop</option>
                    </select>
                  </div>
                  <div className="tenant-form-group full-width">
                    <label>{formatOrganizationType(editForm.organizationType)} Name *</label>
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
                      placeholder="info@facility.com"
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
                    <GhanaRegionSelect
                      value={editForm.region}
                      onChange={(e) => setEditForm({ ...editForm, region: e.target.value })}
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>{formatOrganizationType(editForm.organizationType)} Slogan</label>
                    <input
                      value={editForm.slogan}
                      onChange={(e) => setEditForm({ ...editForm, slogan: e.target.value })}
                      placeholder={editForm.organizationType === 'hospital' ? 'Smart Care. Better Health.' : 'Connected Pharmacy. Better Health.'}
                      maxLength={120}
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
                  <div className="tenant-form-group">
                    <label>{formatOrganizationType(editForm.organizationType)} Logo</label>
                    <div className="tenant-logo-upload-card">
                      {editForm.logoUrl ? (
                        <img src={editForm.logoUrl} alt={`${formatOrganizationType(editForm.organizationType)} logo preview`} className="tenant-logo-preview" />
                      ) : (
                        <div className="tenant-logo-placeholder" aria-hidden="true">
                          {editForm.name?.trim().charAt(0).toUpperCase() || '+'}
                        </div>
                      )}
                      <div className="tenant-logo-upload-copy">
                        <strong>{editForm.logoUrl ? 'Logo selected' : `Add ${formatOrganizationType(editForm.organizationType).toLowerCase()} logo`}</strong>
                        <span>Shown on dashboard and receipts. Max 750KB.</span>
                        <input type="file" accept="image/*" onChange={handleEditLogoChange} />
                      </div>
                    </div>
                    {editForm.logoUrl && (
                      <button
                        type="button"
                        className="btn btn-outline"
                        onClick={() => setEditForm({ ...editForm, logoUrl: '' })}
                      >
                        Remove Logo
                      </button>
                    )}
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
                    <label>Commercial Plan</label>
                    <select
                      value={editForm.planCode}
                      onChange={(e) => setEditForm({ ...editForm, planCode: e.target.value })}
                    >
                      <option value="starter">Starter</option>
                      <option value="professional">Professional</option>
                      <option value="premium">Premium</option>
                    </select>
                  </div>
                  <div className="tenant-form-group">
                    <label>Billing Status</label>
                    <select
                      value={editForm.billingStatus}
                      onChange={(e) => setEditForm({ ...editForm, billingStatus: e.target.value })}
                    >
                      <option value="trial">Trial</option>
                      <option value="active">Active</option>
                      <option value="past_due">Past due</option>
                      <option value="suspended">Suspended</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                  <div className="tenant-form-group">
                    <label>Support Level</label>
                    <select
                      value={editForm.supportLevel}
                      onChange={(e) => setEditForm({ ...editForm, supportLevel: e.target.value })}
                    >
                      <option value="standard">Standard</option>
                      <option value="priority">Priority</option>
                      <option value="premium">Premium</option>
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
                  <div className="tenant-form-group">
                    <label>Last Payment</label>
                    <input
                      type="date"
                      value={editForm.lastPaymentAt}
                      onChange={(e) => setEditForm({ ...editForm, lastPaymentAt: e.target.value })}
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>Next Payment Due</label>
                    <input
                      type="date"
                      value={editForm.nextPaymentDueAt}
                      onChange={(e) => setEditForm({ ...editForm, nextPaymentDueAt: e.target.value })}
                    />
                  </div>
                  <div className="tenant-form-group">
                    <label>Module Privileges</label>
                    <label className="tenant-checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.canUseClaims)}
                        onChange={(e) => setEditForm({ ...editForm, canUseClaims: e.target.checked })}
                      />
                      Claims
                    </label>
                    <label className="tenant-checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.canUsePurchases)}
                        onChange={(e) => setEditForm({ ...editForm, canUsePurchases: e.target.checked })}
                      />
                      Purchases
                    </label>
                    <label className="tenant-checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.canUseNhis)}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            canUseNhis: e.target.checked,
                            canUseNhisTopups: e.target.checked ? editForm.canUseNhisTopups : false,
                          })
                        }
                      />
                      NHIS
                    </label>
                    <label className="tenant-checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.canUseNhis && editForm.canUseNhisTopups)}
                        disabled={!editForm.canUseNhis}
                        onChange={(e) => setEditForm({ ...editForm, canUseNhisTopups: e.target.checked })}
                      />
                      NHIS top-ups
                    </label>
                    <label className="tenant-checkbox-label">
                      NHIS top-up policy
                      <select
                        value={editForm.nhisTopUpPolicy || 'not_allowed'}
                        disabled={!editForm.canUseNhis}
                        onChange={(e) => setEditForm({ ...editForm, nhisTopUpPolicy: e.target.value })}
                      >
                        <option value="not_allowed">Not allowed</option>
                        <option value="allowed">Allowed</option>
                        <option value="required_when_nhis_below_selling_value">Required when NHIS is lower</option>
                      </select>
                    </label>
                    <label className="tenant-checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.canUseAccounting)}
                        onChange={(e) => setEditForm({ ...editForm, canUseAccounting: e.target.checked })}
                      />
                      Accounting
                    </label>
                    <label className="tenant-checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.canUseMultiBranch)}
                        onChange={(e) => setEditForm({ ...editForm, canUseMultiBranch: e.target.checked })}
                      />
                      Multi-branch
                    </label>
                    <label className="tenant-checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(editForm.canUseOfflineInstaller)}
                        onChange={(e) => setEditForm({ ...editForm, canUseOfflineInstaller: e.target.checked })}
                      />
                      Offline installer downloads
                    </label>
                  </div>
                  <div className="tenant-form-group full-width">
                    <label>Billing Notes</label>
                    <textarea
                      rows="3"
                      value={editForm.billingNotes}
                      onChange={(e) => setEditForm({ ...editForm, billingNotes: e.target.value })}
                      placeholder="Payment method, onboarding notes, support terms..."
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
