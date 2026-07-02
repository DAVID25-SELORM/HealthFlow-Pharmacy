import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ClipboardCheck,
  Package,
  RefreshCcw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Truck,
  X,
  XCircle,
} from 'lucide-react'
import { isSupabaseConfigured } from '../lib/supabase'
import { useNotification } from '../context/NotificationContext'
import { useTenant } from '../context/TenantContext'
import { formatAppDate } from '../utils/date'
import { confirmAction } from '../utils/actionConfirmation'
import {
  EPHARMACY_SALE_CLASSES,
  createEpharmacyOrder,
  formatEpharmacyStatus,
  getEpharmacyMarketplace,
  saveEpharmacyProfile,
  updateEpharmacyListingControls,
  updateEpharmacyOrderStatus,
} from '../services/epharmacyService'
import './EPharmacy.css'

const tabs = [
  { value: 'marketplace', label: 'Marketplace', icon: Search },
  { value: 'orders', label: 'Orders', icon: ClipboardCheck },
  { value: 'controls', label: 'Controls', icon: Settings },
]

const currency = (value) =>
  `GHS ${Number(value || 0).toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const getFacilityName = (facility) => facility?.name || 'Facility'

const getOrderRole = (order, organizationId) => {
  if (order?.seller_organization_id === organizationId) return 'seller'
  if (order?.buyer_organization_id === organizationId) return 'buyer'
  return 'viewer'
}

const createProfileForm = (facility = {}) => ({
  enabled: Boolean(facility.epharmacy_enabled),
  licenseNumber: facility.license_number || '',
  certificateNumber: facility.epharmacy_certificate_number || '',
  pharmacistInChargeName: facility.pharmacist_in_charge_name || '',
  pharmacistInChargeRegNo: facility.pharmacist_in_charge_reg_no || '',
  contactPhone: facility.epharmacy_contact_phone || facility.phone || '',
  contactEmail: facility.epharmacy_contact_email || facility.email || '',
  pickupEnabled: facility.epharmacy_pickup_enabled !== false,
  deliveryEnabled: Boolean(facility.epharmacy_delivery_enabled),
  minimumOrderAmount: String(facility.epharmacy_minimum_order_amount || 0),
})

const createControlForm = (drug = {}) => ({
  visible: Boolean(drug.epharmacy_visible),
  interfacilityVisible: Boolean(drug.epharmacy_interfacility_visible),
  customerVisible: Boolean(drug.epharmacy_customer_visible),
  saleClass: drug.sale_class || drug.epharmacy_sale_class || 'otc',
  requiresPrescription: Boolean(drug.prescription_required || drug.epharmacy_requires_prescription),
  pickupEnabled: drug.epharmacy_pickup_enabled !== false,
  deliveryEnabled: Boolean(drug.epharmacy_delivery_enabled),
  warning: drug.epharmacy_warning || '',
})

const getStatusActions = (order, organizationId) => {
  const role = getOrderRole(order, organizationId)
  const status = order.status

  if (role === 'seller') {
    if (status === 'pending_review') return ['approved', 'rejected']
    if (status === 'approved') return ['paid']
    if (status === 'paid') return ['packed']
    if (status === 'packed') return ['out_for_delivery', 'delivered']
    if (status === 'out_for_delivery') return ['delivered']
  }

  if (role === 'buyer' && ['pending_review', 'approved'].includes(status)) {
    return ['cancelled']
  }

  return []
}

const EPharmacy = () => {
  const { organizationId } = useTenant()
  const { notify } = useNotification()
  const [activeTab, setActiveTab] = useState('marketplace')
  const [snapshot, setSnapshot] = useState({
    facility: null,
    facilities: [],
    listings: [],
    ownListings: [],
    orders: [],
  })
  const [searchTerm, setSearchTerm] = useState('')
  const [facilityFilter, setFacilityFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [requestListing, setRequestListing] = useState(null)
  const [orderForm, setOrderForm] = useState({
    quantity: '1',
    fulfillmentMethod: 'pickup',
    paymentMethod: 'momo',
    notes: '',
  })
  const [submittingOrder, setSubmittingOrder] = useState(false)
  const [profileForm, setProfileForm] = useState(createProfileForm())
  const [savingProfile, setSavingProfile] = useState(false)
  const [controlDrug, setControlDrug] = useState(null)
  const [controlForm, setControlForm] = useState(createControlForm())
  const [savingControl, setSavingControl] = useState(false)
  const [statusUpdatingId, setStatusUpdatingId] = useState('')

  const facilityReady = Boolean(
    snapshot.facility?.epharmacy_enabled &&
      snapshot.facility?.license_number &&
      snapshot.facility?.epharmacy_certificate_number &&
      snapshot.facility?.pharmacist_in_charge_reg_no
  )

  const orderMetrics = useMemo(() => ({
    buying: snapshot.orders.filter((order) => order.buyer_organization_id === organizationId).length,
    selling: snapshot.orders.filter((order) => order.seller_organization_id === organizationId).length,
    pendingReview: snapshot.orders.filter((order) => order.status === 'pending_review').length,
  }), [organizationId, snapshot.orders])

  const marketplaceMetrics = useMemo(() => ({
    facilities: snapshot.facilities.length,
    listings: snapshot.listings.length,
    ownPublished: snapshot.ownListings.filter((drug) => drug.epharmacy_interfacility_visible).length,
  }), [snapshot.facilities.length, snapshot.listings.length, snapshot.ownListings])

  const loadMarketplace = async (filters = {}) => {
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured.')
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError('')
      const data = await getEpharmacyMarketplace({
        searchTerm: filters.searchTerm ?? searchTerm,
        facilityId: filters.facilityId ?? facilityFilter,
      })
      setSnapshot({
        facility: data.facility || null,
        facilities: data.facilities || [],
        listings: data.listings || [],
        ownListings: data.ownListings || [],
        orders: data.orders || [],
      })
      setProfileForm(createProfileForm(data.facility || {}))
    } catch (err) {
      setError(err.message || 'Unable to load e-pharmacy.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadMarketplace()
  }, [])

  const handleSearch = (event) => {
    event.preventDefault()
    void loadMarketplace({ searchTerm, facilityId: facilityFilter })
  }

  const openRequestModal = (listing) => {
    setRequestListing(listing)
    setOrderForm({
      quantity: '1',
      fulfillmentMethod: listing.epharmacy_pickup_enabled === false ? 'delivery' : 'pickup',
      paymentMethod: 'momo',
      notes: '',
    })
  }

  const closeRequestModal = () => {
    setRequestListing(null)
    setOrderForm({ quantity: '1', fulfillmentMethod: 'pickup', paymentMethod: 'momo', notes: '' })
  }

  const handleCreateOrder = async (event) => {
    event.preventDefault()
    if (!requestListing) return

    try {
      setSubmittingOrder(true)
      await createEpharmacyOrder({
        sellerOrganizationId: requestListing.organization_id,
        sellerBranchId: requestListing.branch_id,
        fulfillmentMethod: orderForm.fulfillmentMethod,
        paymentMethod: orderForm.paymentMethod,
        notes: orderForm.notes,
        items: [{
          drugId: requestListing.id,
          quantity: orderForm.quantity,
        }],
      })
      notify('E-pharmacy order sent for pharmacist review.', 'success')
      closeRequestModal()
      setActiveTab('orders')
      await loadMarketplace()
    } catch (err) {
      notify(err.message || 'Unable to create e-pharmacy order.', 'error')
    } finally {
      setSubmittingOrder(false)
    }
  }

  const handleSaveProfile = async (event) => {
    event.preventDefault()
    try {
      setSavingProfile(true)
      await saveEpharmacyProfile(profileForm)
      notify('E-pharmacy profile saved.', 'success')
      await loadMarketplace()
    } catch (err) {
      notify(err.message || 'Unable to save e-pharmacy profile.', 'error')
    } finally {
      setSavingProfile(false)
    }
  }

  const openControlModal = (drug) => {
    setControlDrug(drug)
    setControlForm(createControlForm(drug))
  }

  const closeControlModal = () => {
    setControlDrug(null)
    setControlForm(createControlForm())
  }

  const handleSaveControl = async (event) => {
    event.preventDefault()
    if (!controlDrug) return

    try {
      setSavingControl(true)
      await updateEpharmacyListingControls(controlDrug.id, {
        ...controlForm,
        visible: controlForm.interfacilityVisible || controlForm.customerVisible,
      })
      notify('Medicine publishing controls saved.', 'success')
      closeControlModal()
      await loadMarketplace()
    } catch (err) {
      notify(err.message || 'Unable to save publishing controls.', 'error')
    } finally {
      setSavingControl(false)
    }
  }

  const handleStatusUpdate = async (order, nextStatus) => {
    let rejectionReason = ''
    let note = ''

    if (nextStatus === 'rejected') {
      rejectionReason = window.prompt('Rejection reason') || ''
      if (!rejectionReason.trim()) return
    }

    if (nextStatus === 'cancelled') {
      note = window.prompt('Cancellation note') || 'Order cancelled'
    }

    if (!confirmAction({
      title: `Move this order to ${formatEpharmacyStatus(nextStatus)}?`,
      details: [
        { label: 'Order', value: order.order_number },
        { label: 'Customer', value: order.customer_name || order.patient_name },
        { label: 'Amount', value: `GHS ${Number(order.total_amount || 0).toFixed(2)}` },
        { label: 'Reason', value: rejectionReason || note },
      ],
      warning: 'This status change is recorded and may affect fulfilment.',
      confirmText: `mark the order as ${formatEpharmacyStatus(nextStatus)}`,
    })) return

    try {
      setStatusUpdatingId(order.id)
      await updateEpharmacyOrderStatus({
        orderId: order.id,
        status: nextStatus,
        note,
        rejectionReason,
      })
      notify(`Order moved to ${formatEpharmacyStatus(nextStatus)}.`, 'success')
      await loadMarketplace()
    } catch (err) {
      notify(err.message || 'Unable to update order.', 'error')
    } finally {
      setStatusUpdatingId('')
    }
  }

  return (
    <div className="epharmacy-page">
      <div className="page-header">
        <div>
          <h1>Licensed E-Pharmacy</h1>
          <p>Facility marketplace and pharmacist-reviewed medicine orders</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-outline" type="button" onClick={() => loadMarketplace()} disabled={loading}>
            <RefreshCcw size={16} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="epharmacy-alert" role="alert">{error}</div>}

      <div className="epharmacy-license-strip">
        <div>
          <span>Facility</span>
          <strong>{getFacilityName(snapshot.facility)}</strong>
        </div>
        <div>
          <span>License</span>
          <strong>{snapshot.facility?.license_number || 'Not set'}</strong>
        </div>
        <div>
          <span>ePharmacy</span>
          <strong>{facilityReady ? 'Registered' : 'Not active'}</strong>
        </div>
        <div>
          <span>Pharmacist</span>
          <strong>{snapshot.facility?.pharmacist_in_charge_name || 'Not set'}</strong>
        </div>
      </div>

      <div className="epharmacy-tabs" role="tablist" aria-label="E-pharmacy views">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`epharmacy-tab ${activeTab === tab.value ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.value)}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'marketplace' && (
        <>
          <div className="epharmacy-stats">
            <div className="epharmacy-stat">
              <span>Licensed Facilities</span>
              <strong>{marketplaceMetrics.facilities}</strong>
            </div>
            <div className="epharmacy-stat">
              <span>Available Listings</span>
              <strong>{marketplaceMetrics.listings}</strong>
            </div>
            <div className="epharmacy-stat">
              <span>Own Published Stock</span>
              <strong>{marketplaceMetrics.ownPublished}</strong>
            </div>
          </div>

          <form className="epharmacy-controls" onSubmit={handleSearch}>
            <label className="epharmacy-search">
              <Search size={16} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search medicine, brand, generic, category"
              />
            </label>
            <label className="epharmacy-select">
              <ShieldCheck size={16} />
              <select value={facilityFilter} onChange={(event) => setFacilityFilter(event.target.value)}>
                <option value="">All licensed facilities</option>
                {snapshot.facilities.map((facility) => (
                  <option key={facility.id} value={facility.id}>{facility.name}</option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" type="submit">
              <Search size={16} /> Search
            </button>
          </form>

          <div className="epharmacy-table-wrap">
            <table className="epharmacy-table">
              <thead>
                <tr>
                  <th>Medicine</th>
                  <th>Facility</th>
                  <th>Branch</th>
                  <th>Available</th>
                  <th>Price</th>
                  <th>Class</th>
                  <th>Fulfillment</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="empty-row">Loading e-pharmacy stock...</td></tr>
                ) : snapshot.listings.length === 0 ? (
                  <tr><td colSpan={8} className="empty-row">No published surplus stock found.</td></tr>
                ) : (
                  snapshot.listings.map((listing) => {
                    const isOwnStock = listing.organization_id === organizationId
                    return (
                      <tr key={listing.id}>
                        <td>
                          <div className="medicine-name">{listing.name}</div>
                          {(listing.brand_name || listing.generic_name) && (
                            <div className="medicine-meta">
                              {[listing.brand_name, listing.generic_name].filter(Boolean).join(' / ')}
                            </div>
                          )}
                          {listing.epharmacy_warning && <div className="medicine-meta">{listing.epharmacy_warning}</div>}
                        </td>
                        <td>
                          <div className="facility-name">{listing.facility?.name || 'Facility'}</div>
                          <div className="medicine-meta">{listing.facility?.license_number || 'License pending'}</div>
                        </td>
                        <td>{listing.branch?.name || 'Main'}</td>
                        <td>{listing.available_quantity} {listing.unit || 'unit'}</td>
                        <td>{currency(listing.price)}</td>
                        <td>
                          <span className={`epharmacy-pill epharmacy-pill--${listing.sale_class}`}>
                            {listing.sale_class}
                          </span>
                          {listing.prescription_required && <div className="medicine-meta">Review required</div>}
                        </td>
                        <td>{listing.epharmacy_delivery_enabled ? 'Pickup / Delivery' : 'Pickup'}</td>
                        <td>
                          <button
                            className="btn btn-primary btn-compact"
                            type="button"
                            disabled={isOwnStock}
                            onClick={() => openRequestModal(listing)}
                          >
                            <ShoppingCart size={14} />
                            {isOwnStock ? 'Own stock' : 'Request'}
                          </button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'orders' && (
        <>
          <div className="epharmacy-stats">
            <div className="epharmacy-stat">
              <span>Buying</span>
              <strong>{orderMetrics.buying}</strong>
            </div>
            <div className="epharmacy-stat">
              <span>Selling</span>
              <strong>{orderMetrics.selling}</strong>
            </div>
            <div className="epharmacy-stat">
              <span>Pending Review</span>
              <strong>{orderMetrics.pendingReview}</strong>
            </div>
          </div>

          <div className="epharmacy-table-wrap">
            <table className="epharmacy-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Buyer</th>
                  <th>Seller</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {snapshot.orders.length === 0 ? (
                  <tr><td colSpan={8} className="empty-row">No e-pharmacy orders yet.</td></tr>
                ) : (
                  snapshot.orders.map((order) => {
                    const actions = getStatusActions(order, organizationId)
                    return (
                      <tr key={order.id}>
                        <td>
                          <div className="medicine-name">{order.order_number}</div>
                          <div className="medicine-meta">{order.fulfillment_method}</div>
                        </td>
                        <td>
                          <div>{order.buyer_facility?.name || order.customer_name || 'Customer'}</div>
                          {order.customer_phone && <div className="medicine-meta">{order.customer_phone}</div>}
                          {order.patient_name && order.patient_name !== order.customer_name && (
                            <div className="medicine-meta">Patient: {order.patient_name}</div>
                          )}
                        </td>
                        <td>{order.seller_facility?.name || 'Facility'}</td>
                        <td>
                          {(order.epharmacy_order_items || []).slice(0, 2).map((item) => (
                            <div key={item.id} className="medicine-meta">
                              {item.drug_name} x {item.quantity}
                            </div>
                          ))}
                          {order.prescription_file_url && (
                            <a
                              className="epharmacy-prescription-link"
                              href={order.prescription_file_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              View prescription
                            </a>
                          )}
                          {order.clinical_notes && (
                            <div className="medicine-meta">Clinical: {order.clinical_notes}</div>
                          )}
                        </td>
                        <td>{currency(order.total_amount)}</td>
                        <td>
                          <span className={`order-status order-status--${order.status}`}>
                            {formatEpharmacyStatus(order.status)}
                          </span>
                        </td>
                        <td>{order.updated_at ? formatAppDate(order.updated_at) : '-'}</td>
                        <td>
                          <div className="order-actions">
                            {actions.map((nextStatus) => (
                              <button
                                key={nextStatus}
                                type="button"
                                className={`icon-btn ${nextStatus === 'rejected' || nextStatus === 'cancelled' ? 'danger' : ''}`}
                                title={formatEpharmacyStatus(nextStatus)}
                                disabled={statusUpdatingId === order.id}
                                onClick={() => handleStatusUpdate(order, nextStatus)}
                              >
                                {nextStatus === 'rejected' || nextStatus === 'cancelled'
                                  ? <XCircle size={15} />
                                  : nextStatus === 'out_for_delivery'
                                    ? <Truck size={15} />
                                    : <CheckCircle2 size={15} />}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'controls' && (
        <div className="epharmacy-controls-grid">
          <form className="epharmacy-panel" onSubmit={handleSaveProfile}>
            <div className="panel-heading">
              <ShieldCheck size={18} />
              <h2>Facility Registration</h2>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={profileForm.enabled}
                onChange={(event) => setProfileForm((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Enable licensed e-pharmacy</span>
            </label>
            <div className="form-grid">
              <label>
                License number
                <input
                  value={profileForm.licenseNumber}
                  onChange={(event) => setProfileForm((current) => ({ ...current, licenseNumber: event.target.value }))}
                />
              </label>
              <label>
                ePharmacy certificate
                <input
                  value={profileForm.certificateNumber}
                  onChange={(event) => setProfileForm((current) => ({ ...current, certificateNumber: event.target.value }))}
                />
              </label>
              <label>
                Pharmacist-in-charge
                <input
                  value={profileForm.pharmacistInChargeName}
                  onChange={(event) => setProfileForm((current) => ({ ...current, pharmacistInChargeName: event.target.value }))}
                />
              </label>
              <label>
                Pharmacist reg. no.
                <input
                  value={profileForm.pharmacistInChargeRegNo}
                  onChange={(event) => setProfileForm((current) => ({ ...current, pharmacistInChargeRegNo: event.target.value }))}
                />
              </label>
              <label>
                Contact phone
                <input
                  value={profileForm.contactPhone}
                  onChange={(event) => setProfileForm((current) => ({ ...current, contactPhone: event.target.value }))}
                />
              </label>
              <label>
                Contact email
                <input
                  value={profileForm.contactEmail}
                  onChange={(event) => setProfileForm((current) => ({ ...current, contactEmail: event.target.value }))}
                />
              </label>
              <label>
                Minimum order
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={profileForm.minimumOrderAmount}
                  onChange={(event) => setProfileForm((current) => ({ ...current, minimumOrderAmount: event.target.value }))}
                />
              </label>
            </div>
            <div className="toggle-grid">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={profileForm.pickupEnabled}
                  onChange={(event) => setProfileForm((current) => ({ ...current, pickupEnabled: event.target.checked }))}
                />
                <span>Pickup</span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={profileForm.deliveryEnabled}
                  onChange={(event) => setProfileForm((current) => ({ ...current, deliveryEnabled: event.target.checked }))}
                />
                <span>Delivery</span>
              </label>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" type="submit" disabled={savingProfile}>
                {savingProfile ? 'Saving...' : 'Save Registration'}
              </button>
            </div>
          </form>

          <div className="epharmacy-panel epharmacy-panel-wide">
            <div className="panel-heading">
              <Package size={18} />
              <h2>Inventory Publishing</h2>
            </div>
            <div className="epharmacy-table-wrap inner">
              <table className="epharmacy-table">
                <thead>
                  <tr>
                    <th>Medicine</th>
                    <th>Branch</th>
                    <th>Stock</th>
                    <th>Surplus</th>
                    <th>Class</th>
                    <th>Published</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.ownListings.length === 0 ? (
                    <tr><td colSpan={7} className="empty-row">No inventory found.</td></tr>
                  ) : (
                    snapshot.ownListings.map((drug) => (
                      <tr key={drug.id}>
                        <td>
                          <div className="medicine-name">{drug.name}</div>
                          <div className="medicine-meta">
                            Exp: {drug.expiry_date ? formatAppDate(drug.expiry_date) : 'Not set'}
                          </div>
                        </td>
                        <td>{drug.branch?.name || 'Main'}</td>
                        <td>{drug.quantity} {drug.unit || 'unit'}</td>
                        <td>{drug.available_quantity}</td>
                        <td>
                          <span className={`epharmacy-pill epharmacy-pill--${drug.sale_class}`}>
                            {drug.sale_class}
                          </span>
                        </td>
                        <td>{drug.epharmacy_interfacility_visible ? 'Inter-facility' : '-'}</td>
                        <td>
                          <button className="btn btn-outline btn-compact" type="button" onClick={() => openControlModal(drug)}>
                            <Settings size={14} /> Controls
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {requestListing && (
        <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && closeRequestModal()}>
          <div className="modal-content epharmacy-modal">
            <div className="modal-header">
              <h2>Request Medicine</h2>
              <button className="close-btn" type="button" onClick={closeRequestModal}><X size={18} /></button>
            </div>
            <form className="epharmacy-form" onSubmit={handleCreateOrder}>
              <div className="request-summary">
                <strong>{requestListing.name}</strong>
                <span>{getFacilityName(requestListing.facility)} - {requestListing.available_quantity} {requestListing.unit || 'unit'} available</span>
              </div>
              <label>
                Quantity
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={requestListing.available_quantity}
                  value={orderForm.quantity}
                  onChange={(event) => setOrderForm((current) => ({ ...current, quantity: event.target.value }))}
                  required
                />
              </label>
              <div className="form-grid">
                <label>
                  Fulfillment
                  <select
                    value={orderForm.fulfillmentMethod}
                    onChange={(event) => setOrderForm((current) => ({ ...current, fulfillmentMethod: event.target.value }))}
                  >
                    <option value="pickup">Pickup</option>
                    {requestListing.epharmacy_delivery_enabled && <option value="delivery">Delivery</option>}
                  </select>
                </label>
                <label>
                  Payment
                  <select
                    value={orderForm.paymentMethod}
                    onChange={(event) => setOrderForm((current) => ({ ...current, paymentMethod: event.target.value }))}
                  >
                    <option value="momo">MoMo</option>
                    <option value="paystack">Paystack</option>
                    <option value="card">Card</option>
                    <option value="account_transfer">Account transfer</option>
                    <option value="credit">Credit</option>
                    <option value="cash_on_delivery">Cash on delivery</option>
                  </select>
                </label>
              </div>
              <label>
                Notes
                <textarea
                  rows="3"
                  value={orderForm.notes}
                  onChange={(event) => setOrderForm((current) => ({ ...current, notes: event.target.value }))}
                />
              </label>
              <div className="request-total">
                <span>Total</span>
                <strong>{currency(Number(orderForm.quantity || 0) * Number(requestListing.price || 0))}</strong>
              </div>
              <div className="form-actions">
                <button className="btn btn-outline" type="button" onClick={closeRequestModal}>Cancel</button>
                <button className="btn btn-primary" type="submit" disabled={submittingOrder}>
                  {submittingOrder ? 'Sending...' : 'Send for Review'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {controlDrug && (
        <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && closeControlModal()}>
          <div className="modal-content epharmacy-modal">
            <div className="modal-header">
              <h2>Publishing Controls</h2>
              <button className="close-btn" type="button" onClick={closeControlModal}><X size={18} /></button>
            </div>
            <form className="epharmacy-form" onSubmit={handleSaveControl}>
              <div className="request-summary">
                <strong>{controlDrug.name}</strong>
                <span>{controlDrug.quantity} {controlDrug.unit || 'unit'} in stock</span>
              </div>
              <label>
                Medicine class
                <select
                  value={controlForm.saleClass}
                  onChange={(event) =>
                    setControlForm((current) => ({ ...current, saleClass: event.target.value }))
                  }
                >
                  {EPHARMACY_SALE_CLASSES.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              <div className="toggle-grid">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={controlForm.interfacilityVisible}
                    onChange={(event) =>
                      setControlForm((current) => ({ ...current, interfacilityVisible: event.target.checked }))
                    }
                  />
                  <span>Inter-facility</span>
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={controlForm.customerVisible}
                    onChange={(event) =>
                      setControlForm((current) => ({ ...current, customerVisible: event.target.checked }))
                    }
                  />
                  <span>Customer portal</span>
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={controlForm.requiresPrescription}
                    onChange={(event) =>
                      setControlForm((current) => ({ ...current, requiresPrescription: event.target.checked }))
                    }
                  />
                  <span>Prescription</span>
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={controlForm.deliveryEnabled}
                    onChange={(event) =>
                      setControlForm((current) => ({ ...current, deliveryEnabled: event.target.checked }))
                    }
                  />
                  <span>Delivery</span>
                </label>
              </div>
              <label>
                Warning
                <textarea
                  rows="3"
                  value={controlForm.warning}
                  onChange={(event) => setControlForm((current) => ({ ...current, warning: event.target.value }))}
                />
              </label>
              <div className="form-actions">
                <button className="btn btn-outline" type="button" onClick={closeControlModal}>Cancel</button>
                <button className="btn btn-primary" type="submit" disabled={savingControl}>
                  {savingControl ? 'Saving...' : 'Save Controls'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default EPharmacy
