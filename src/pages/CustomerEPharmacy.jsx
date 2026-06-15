import { useEffect, useMemo, useState } from 'react'
import {
  Apple,
  CheckCircle2,
  LogOut,
  Mail,
  MapPin,
  Search,
  ShieldCheck,
  ShoppingCart,
  Upload,
} from 'lucide-react'
import Seo from '../components/Seo/Seo'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import {
  createCustomerOrder,
  getCustomerAccount,
  getCustomerCheckoutRequirements,
  getCustomerMarketplace,
  saveCustomerProfile,
  sendCustomerMagicLink,
  signInCustomerWithProvider,
  removeCustomerPrescription,
  uploadCustomerPrescription,
} from '../services/customerEpharmacyService'
import './CustomerEPharmacy.css'

const emptyProfile = {
  fullName: '',
  phone: '',
  dateOfBirth: '',
  gender: '',
  identityType: 'ghana_card',
  identityNumber: '',
  address: '',
  city: '',
  region: '',
  digitalAddress: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  allergies: '',
  currentMedications: '',
  termsAccepted: false,
  privacyConsent: false,
}

const emptyOrder = {
  quantity: '1',
  fulfillmentMethod: 'pickup',
  paymentMethod: 'momo',
  orderingFor: 'self',
  patientName: '',
  patientDateOfBirth: '',
  patientRelationship: '',
  deliveryAddress: '',
  deliveryCity: '',
  deliveryRegion: '',
  deliveryDigitalAddress: '',
  notes: '',
  clinicalNotes: '',
}

const currency = (value) =>
  `GHS ${Number(value || 0).toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const mapProfile = (profile = {}, user = {}) => ({
  ...emptyProfile,
  fullName: profile.full_name || user.user_metadata?.full_name || user.user_metadata?.name || '',
  phone: profile.phone || '',
  dateOfBirth: profile.date_of_birth || '',
  gender: profile.gender || '',
  identityType: profile.identity_type || 'ghana_card',
  identityNumber: profile.identity_number || '',
  address: profile.address || '',
  city: profile.city || '',
  region: profile.region || '',
  digitalAddress: profile.digital_address || '',
  emergencyContactName: profile.emergency_contact_name || '',
  emergencyContactPhone: profile.emergency_contact_phone || '',
  allergies: profile.allergies || '',
  currentMedications: profile.current_medications || '',
  termsAccepted: Boolean(profile.terms_accepted_at),
  privacyConsent: Boolean(profile.privacy_consent_at),
})

const CustomerEPharmacy = () => {
  const { user, isAuthenticated, signOut } = useAuth()
  const { notify } = useNotification()
  const [marketplace, setMarketplace] = useState({ facilities: [], listings: [] })
  const [account, setAccount] = useState({ profile: null, orders: [] })
  const [profileForm, setProfileForm] = useState(emptyProfile)
  const [searchTerm, setSearchTerm] = useState('')
  const [facilityFilter, setFacilityFilter] = useState('')
  const [email, setEmail] = useState('')
  const [selectedListing, setSelectedListing] = useState(null)
  const [orderForm, setOrderForm] = useState(emptyOrder)
  const [prescription, setPrescription] = useState(null)
  const [activeView, setActiveView] = useState('shop')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const loadMarketplace = async (filters = {}) => {
    try {
      setLoading(true)
      setError('')
      const data = await getCustomerMarketplace({
        searchTerm: filters.searchTerm ?? searchTerm,
        facilityId: filters.facilityId ?? facilityFilter,
      })
      setMarketplace({
        facilities: data.facilities || [],
        listings: data.listings || [],
      })
    } catch (loadError) {
      setError(loadError.message || 'Unable to load the customer pharmacy.')
    } finally {
      setLoading(false)
    }
  }

  const loadAccount = async () => {
    if (!isAuthenticated) {
      setAccount({ profile: null, orders: [] })
      setProfileForm(emptyProfile)
      return
    }

    try {
      const data = await getCustomerAccount()
      setAccount({ profile: data.profile || null, orders: data.orders || [] })
      setProfileForm(mapProfile(data.profile, user))
    } catch (accountError) {
      setError(accountError.message || 'Unable to load your customer account.')
    }
  }

  useEffect(() => {
    void loadMarketplace()
  }, [])

  useEffect(() => {
    void loadAccount()
  }, [isAuthenticated, user?.id])

  const requirements = useMemo(
    () =>
      getCustomerCheckoutRequirements({
        listing: selectedListing,
        fulfillmentMethod: orderForm.fulfillmentMethod,
        orderingFor: orderForm.orderingFor,
      }),
    [orderForm.fulfillmentMethod, orderForm.orderingFor, selectedListing]
  )

  const startOrder = (listing) => {
    setSelectedListing(listing)
    setPrescription(null)
    setOrderForm({
      ...emptyOrder,
      fulfillmentMethod: listing.epharmacy_pickup_enabled === false ? 'delivery' : 'pickup',
      patientName: profileForm.fullName,
      patientDateOfBirth: profileForm.dateOfBirth,
      deliveryAddress: profileForm.address,
      deliveryCity: profileForm.city,
      deliveryRegion: profileForm.region,
      deliveryDigitalAddress: profileForm.digitalAddress,
    })
  }

  const handleMagicLink = async (event) => {
    event.preventDefault()
    try {
      setBusy('magic-link')
      await sendCustomerMagicLink(email)
      notify('Sign-in link sent. Check your email and return to the customer pharmacy.', 'success', 7000)
    } catch (authError) {
      notify(authError.message || 'Unable to send the sign-in link.', 'error')
    } finally {
      setBusy('')
    }
  }

  const handleSocialSignIn = async (provider) => {
    try {
      setBusy(provider)
      await signInCustomerWithProvider(provider)
    } catch (authError) {
      notify(
        authError.message ||
          `${provider === 'google' ? 'Google' : 'Apple'} sign-in is not available.`,
        'error'
      )
      setBusy('')
    }
  }

  const handleSaveProfile = async (event) => {
    event.preventDefault()
    try {
      setBusy('profile')
      const data = await saveCustomerProfile(profileForm)
      setAccount((current) => ({ ...current, profile: data.profile }))
      setProfileForm(mapProfile(data.profile, user))
      notify('Customer profile saved.', 'success')
    } catch (profileError) {
      notify(profileError.message || 'Unable to save your profile.', 'error')
    } finally {
      setBusy('')
    }
  }

  const handleOrder = async (event) => {
    event.preventDefault()
    if (!selectedListing) return

    if (!isAuthenticated) {
      notify('Sign in before placing an order.', 'warning')
      return
    }

    let prescriptionUpload = null
    try {
      setBusy('order')
      if (requirements.requiresPrescriptionUpload) {
        prescriptionUpload = await uploadCustomerPrescription(user.id, prescription)
      }

      await saveCustomerProfile(profileForm)
      const data = await createCustomerOrder({
        sellerOrganizationId: selectedListing.organization_id,
        sellerBranchId: selectedListing.branch_id,
        fulfillmentMethod: orderForm.fulfillmentMethod,
        paymentMethod: orderForm.paymentMethod,
        orderingFor: orderForm.orderingFor,
        patientName: orderForm.orderingFor === 'self' ? profileForm.fullName : orderForm.patientName,
        patientDateOfBirth:
          orderForm.orderingFor === 'self' ? profileForm.dateOfBirth : orderForm.patientDateOfBirth,
        patientRelationship: orderForm.patientRelationship,
        deliveryAddress: orderForm.deliveryAddress,
        deliveryCity: orderForm.deliveryCity,
        deliveryRegion: orderForm.deliveryRegion,
        deliveryDigitalAddress: orderForm.deliveryDigitalAddress,
        notes: orderForm.notes,
        clinicalNotes: orderForm.clinicalNotes,
        prescription: prescriptionUpload,
        items: [{ drugId: selectedListing.id, quantity: Number(orderForm.quantity) }],
      })
      setAccount((current) => ({ ...current, orders: data.orders || current.orders }))
      setSelectedListing(null)
      setActiveView('orders')
      notify('Order sent to the facility pharmacist for review.', 'success')
      await loadMarketplace()
    } catch (orderError) {
      if (prescriptionUpload?.path) {
        await removeCustomerPrescription(prescriptionUpload.path).catch(() => null)
      }
      notify(orderError.message || 'Unable to place the order.', 'error')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="customer-shop-page">
      <Seo
        title="Shop Medicines Online"
        description="Order medicines online from licensed pharmacies with pharmacist-reviewed orders, pickup and delivery options on HealthFlow."
        path="/shop"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'Pharmacy',
          name: 'HealthFlow Customer Pharmacy',
          description: 'Licensed facilities and pharmacist-reviewed orders.',
          url: 'https://health-flow-pharmacy.vercel.app/shop',
          medicalSpecialty: 'Pharmacy',
        }}
      />
      <header className="customer-shop-header">
        <a className="customer-shop-brand" href="/shop">
          <img src="/app-logo-display.jpg" alt="HealthFlow" width="640" height="320" />
          <div>
            <strong>HealthFlow Customer Pharmacy</strong>
            <span>Licensed facilities and pharmacist-reviewed orders</span>
          </div>
        </a>
        <nav>
          <button type="button" onClick={() => setActiveView('shop')}>Shop</button>
          <button type="button" onClick={() => setActiveView('orders')}>My orders</button>
          <button type="button" onClick={() => setActiveView('profile')}>My profile</button>
          {isAuthenticated ? (
            <button type="button" onClick={() => void signOut()}><LogOut size={16} /> Sign out</button>
          ) : (
            <button type="button" onClick={() => setActiveView('account')}>Sign in</button>
          )}
        </nav>
      </header>

      <main className="customer-shop-main">
        <section className="customer-shop-hero">
          <div>
            <span className="customer-shop-eyebrow"><ShieldCheck size={16} /> Licensed E-Pharmacy</span>
            <h1>Order medicines with the right level of care.</h1>
            <p>
              OTC checkout stays simple. Prescription requests collect the patient and prescription
              details needed for pharmacist review.
            </p>
          </div>
          <div className="customer-shop-trust">
            <div><CheckCircle2 size={18} /><span>Licensed facilities</span></div>
            <div><CheckCircle2 size={18} /><span>Private prescriptions</span></div>
            <div><CheckCircle2 size={18} /><span>Pharmacist review</span></div>
          </div>
        </section>

        {error && <div className="customer-shop-alert">{error}</div>}

        {activeView === 'shop' && (
          <>
            <form
              className="customer-shop-search"
              onSubmit={(event) => {
                event.preventDefault()
                void loadMarketplace()
              }}
            >
              <label>
                <Search size={18} />
                <input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search medicine, brand, generic name, or category"
                />
              </label>
              <select value={facilityFilter} onChange={(event) => setFacilityFilter(event.target.value)}>
                <option value="">All licensed facilities</option>
                {marketplace.facilities.map((facility) => (
                  <option key={facility.id} value={facility.id}>{facility.name}</option>
                ))}
              </select>
              <button className="btn btn-primary" type="submit">Search</button>
            </form>

            <div className="customer-shop-grid">
              {loading ? (
                <div className="customer-shop-empty">Loading available medicines...</div>
              ) : marketplace.listings.length === 0 ? (
                <div className="customer-shop-empty">No customer medicines match your search.</div>
              ) : (
                marketplace.listings.map((listing) => (
                  <article className="customer-medicine-card" key={listing.id}>
                    <div className="customer-medicine-card-top">
                      <span className={`customer-medicine-class ${listing.sale_class}`}>
                        {listing.sale_class === 'prescription' ? 'Prescription' : 'OTC'}
                      </span>
                      <span>{listing.available_quantity} {listing.unit || 'unit'} available</span>
                    </div>
                    <h2>{listing.name}</h2>
                    <p>{[listing.brand_name, listing.generic_name].filter(Boolean).join(' / ')}</p>
                    <div className="customer-facility-line">
                      <MapPin size={15} />
                      <span>{listing.facility?.name || 'Licensed facility'} · {listing.facility?.city || listing.facility?.region || 'Ghana'}</span>
                    </div>
                    {listing.epharmacy_warning && <div className="customer-medicine-warning">{listing.epharmacy_warning}</div>}
                    <footer>
                      <strong>{currency(listing.price)}</strong>
                      <button className="btn btn-primary" type="button" onClick={() => startOrder(listing)}>
                        <ShoppingCart size={16} /> Request
                      </button>
                    </footer>
                  </article>
                ))
              )}
            </div>
          </>
        )}

        {activeView === 'account' && !isAuthenticated && (
          <section className="customer-account-card">
            <h2>Create or access your customer account</h2>
            <p>Use Google or Apple, or enter any email address including Yahoo for a secure sign-in link.</p>
            <div className="customer-social-buttons">
              <button type="button" onClick={() => void handleSocialSignIn('google')} disabled={Boolean(busy)}>
                <span className="google-mark">G</span> Continue with Google
              </button>
              <button type="button" onClick={() => void handleSocialSignIn('apple')} disabled={Boolean(busy)}>
                <Apple size={18} /> Continue with Apple
              </button>
            </div>
            <div className="customer-auth-divider"><span>or use email</span></div>
            <form onSubmit={handleMagicLink}>
              <label>
                Email address
                <div className="customer-input-icon">
                  <Mail size={17} />
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@yahoo.com"
                    required
                  />
                </div>
              </label>
              <button className="btn btn-primary" type="submit" disabled={Boolean(busy)}>
                {busy === 'magic-link' ? 'Sending...' : 'Email me a sign-in link'}
              </button>
            </form>
          </section>
        )}

        {activeView === 'orders' && (
          <section className="customer-orders-card">
            <h2>My orders</h2>
            {!isAuthenticated ? (
              <p>Sign in to view and track your orders.</p>
            ) : account.orders.length === 0 ? (
              <p>You have not placed any customer orders yet.</p>
            ) : (
              <div className="customer-orders-list">
                {account.orders.map((order) => (
                  <article key={order.id}>
                    <div>
                      <strong>{order.order_number}</strong>
                      <span>{order.seller_facility?.name || 'Licensed facility'}</span>
                    </div>
                    <div>
                      <strong>{currency(order.total_amount)}</strong>
                      <span>{String(order.status || '').replace(/_/g, ' ')}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {activeView === 'profile' && (
          <section className="customer-profile-card">
            <h2>Customer profile</h2>
            {!isAuthenticated ? (
              <p>Sign in before creating your customer profile.</p>
            ) : (
              <form onSubmit={handleSaveProfile}>
                <div className="customer-form-grid">
                  <label>Full legal name<input value={profileForm.fullName} onChange={(e) => setProfileForm((p) => ({ ...p, fullName: e.target.value }))} required /></label>
                  <label>Mobile number<input type="tel" value={profileForm.phone} onChange={(e) => setProfileForm((p) => ({ ...p, phone: e.target.value }))} required /></label>
                  <label>Date of birth<input type="date" value={profileForm.dateOfBirth} onChange={(e) => setProfileForm((p) => ({ ...p, dateOfBirth: e.target.value }))} /></label>
                  <label>Gender<select value={profileForm.gender} onChange={(e) => setProfileForm((p) => ({ ...p, gender: e.target.value }))}><option value="">Select</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="prefer_not_to_say">Prefer not to say</option></select></label>
                  <label>Identity type<select value={profileForm.identityType} onChange={(e) => setProfileForm((p) => ({ ...p, identityType: e.target.value }))}><option value="ghana_card">Ghana Card</option><option value="passport">Passport</option><option value="other">Other ID</option></select></label>
                  <label>Identity number<input value={profileForm.identityNumber} onChange={(e) => setProfileForm((p) => ({ ...p, identityNumber: e.target.value }))} /></label>
                  <label className="wide">Residential address<input value={profileForm.address} onChange={(e) => setProfileForm((p) => ({ ...p, address: e.target.value }))} /></label>
                  <label>City<input value={profileForm.city} onChange={(e) => setProfileForm((p) => ({ ...p, city: e.target.value }))} /></label>
                  <label>Region<input value={profileForm.region} onChange={(e) => setProfileForm((p) => ({ ...p, region: e.target.value }))} /></label>
                  <label>Digital address<input value={profileForm.digitalAddress} onChange={(e) => setProfileForm((p) => ({ ...p, digitalAddress: e.target.value }))} /></label>
                  <label>Allergies<input value={profileForm.allergies} onChange={(e) => setProfileForm((p) => ({ ...p, allergies: e.target.value }))} /></label>
                  <label className="wide">Current medicines<input value={profileForm.currentMedications} onChange={(e) => setProfileForm((p) => ({ ...p, currentMedications: e.target.value }))} /></label>
                </div>
                <label className="customer-consent"><input type="checkbox" checked={profileForm.termsAccepted} onChange={(e) => setProfileForm((p) => ({ ...p, termsAccepted: e.target.checked }))} required /> I accept the customer E-Pharmacy terms.</label>
                <label className="customer-consent"><input type="checkbox" checked={profileForm.privacyConsent} onChange={(e) => setProfileForm((p) => ({ ...p, privacyConsent: e.target.checked }))} required /> I consent to pharmacists reviewing information supplied for my orders.</label>
                <button className="btn btn-primary" type="submit" disabled={busy === 'profile'}>{busy === 'profile' ? 'Saving...' : 'Save profile'}</button>
              </form>
            )}
          </section>
        )}
      </main>

      {selectedListing && (
        <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && setSelectedListing(null)}>
          <div className="modal-content customer-checkout-modal">
            <div className="modal-header">
              <div>
                <h2>Request {selectedListing.name}</h2>
                <p>{requirements.prescription ? 'Prescription and pharmacist review required' : 'Simple OTC checkout'}</p>
              </div>
              <button type="button" className="close-btn" onClick={() => setSelectedListing(null)}>×</button>
            </div>

            {!isAuthenticated ? (
              <div className="customer-checkout-signin">
                <p>Create or access your customer account before ordering.</p>
                <button className="btn btn-primary" type="button" onClick={() => { setSelectedListing(null); setActiveView('account') }}>Continue to sign in</button>
              </div>
            ) : (
              <form className="customer-checkout-form" onSubmit={handleOrder}>
                <fieldset>
                  <legend>Customer contact</legend>
                  <div className="customer-form-grid">
                    <label>
                      Full legal name
                      <input
                        value={profileForm.fullName}
                        onChange={(e) => setProfileForm((p) => ({ ...p, fullName: e.target.value }))}
                        required
                      />
                    </label>
                    <label>
                      Mobile number
                      <input
                        type="tel"
                        value={profileForm.phone}
                        onChange={(e) => setProfileForm((p) => ({ ...p, phone: e.target.value }))}
                        required
                      />
                    </label>
                  </div>
                </fieldset>

                <div className="customer-form-grid">
                  <label>Quantity<input type="number" min="1" max={selectedListing.available_quantity} value={orderForm.quantity} onChange={(e) => setOrderForm((o) => ({ ...o, quantity: e.target.value }))} required /></label>
                  <label>Fulfillment<select value={orderForm.fulfillmentMethod} onChange={(e) => setOrderForm((o) => ({ ...o, fulfillmentMethod: e.target.value }))}><option value="pickup">Pickup</option>{selectedListing.epharmacy_delivery_enabled && <option value="delivery">Delivery</option>}</select></label>
                  <label>Payment method<select value={orderForm.paymentMethod} onChange={(e) => setOrderForm((o) => ({ ...o, paymentMethod: e.target.value }))}><option value="momo">MoMo</option><option value="paystack">Paystack</option><option value="card">Card</option><option value="account_transfer">Account transfer</option><option value="cash_on_delivery">Cash on delivery</option></select></label>
                  <label>Ordering for<select value={orderForm.orderingFor} onChange={(e) => setOrderForm((o) => ({ ...o, orderingFor: e.target.value }))}><option value="self">Myself</option><option value="child">My child</option><option value="dependent">A dependent</option><option value="other">Another person</option></select></label>
                </div>

                {requirements.requiresPatientDetails && (
                  <fieldset>
                    <legend>Patient details</legend>
                    <div className="customer-form-grid">
                      <label>Patient full name<input value={orderForm.orderingFor === 'self' ? profileForm.fullName : orderForm.patientName} onChange={(e) => setOrderForm((o) => ({ ...o, patientName: e.target.value }))} disabled={orderForm.orderingFor === 'self'} required /></label>
                      <label>Patient date of birth<input type="date" value={orderForm.orderingFor === 'self' ? profileForm.dateOfBirth : orderForm.patientDateOfBirth} onChange={(e) => setOrderForm((o) => ({ ...o, patientDateOfBirth: e.target.value }))} disabled={orderForm.orderingFor === 'self'} required /></label>
                      {orderForm.orderingFor !== 'self' && <label>Relationship<input value={orderForm.patientRelationship} onChange={(e) => setOrderForm((o) => ({ ...o, patientRelationship: e.target.value }))} required /></label>}
                    </div>
                  </fieldset>
                )}

                {requirements.requiresClinicalDetails && (
                  <fieldset>
                    <legend>Clinical review</legend>
                    <div className="customer-form-grid">
                      <label>
                        Your date of birth
                        <input
                          type="date"
                          value={profileForm.dateOfBirth}
                          onChange={(e) => setProfileForm((p) => ({ ...p, dateOfBirth: e.target.value }))}
                          required
                        />
                      </label>
                      <label>
                        Gender
                        <select
                          value={profileForm.gender}
                          onChange={(e) => setProfileForm((p) => ({ ...p, gender: e.target.value }))}
                          required
                        >
                          <option value="">Select</option>
                          <option value="female">Female</option>
                          <option value="male">Male</option>
                          <option value="other">Other</option>
                          <option value="prefer_not_to_say">Prefer not to say</option>
                        </select>
                      </label>
                      <label>
                        Identity type
                        <select
                          value={profileForm.identityType}
                          onChange={(e) => setProfileForm((p) => ({ ...p, identityType: e.target.value }))}
                          required
                        >
                          <option value="ghana_card">Ghana Card</option>
                          <option value="passport">Passport</option>
                          <option value="other">Other ID</option>
                        </select>
                      </label>
                      <label>
                        Identity number
                        <input
                          value={profileForm.identityNumber}
                          onChange={(e) => setProfileForm((p) => ({ ...p, identityNumber: e.target.value }))}
                          required
                        />
                      </label>
                      <label>Allergies<input value={profileForm.allergies} onChange={(e) => setProfileForm((p) => ({ ...p, allergies: e.target.value }))} required /></label>
                      <label>Current medicines<input value={profileForm.currentMedications} onChange={(e) => setProfileForm((p) => ({ ...p, currentMedications: e.target.value }))} required /></label>
                      <label className="wide">Symptoms or pharmacist note<textarea rows="3" value={orderForm.clinicalNotes} onChange={(e) => setOrderForm((o) => ({ ...o, clinicalNotes: e.target.value }))} /></label>
                    </div>
                    <label className="customer-file-upload">
                      <Upload size={18} />
                      <span>{prescription ? prescription.name : 'Upload prescription (PDF or image, max 8MB)'}</span>
                      <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" onChange={(e) => setPrescription(e.target.files?.[0] || null)} required />
                    </label>
                  </fieldset>
                )}

                {requirements.requiresDeliveryAddress && (
                  <fieldset>
                    <legend>Delivery address</legend>
                    <div className="customer-form-grid">
                      <label className="wide">Address<input value={orderForm.deliveryAddress} onChange={(e) => setOrderForm((o) => ({ ...o, deliveryAddress: e.target.value }))} required /></label>
                      <label>City<input value={orderForm.deliveryCity} onChange={(e) => setOrderForm((o) => ({ ...o, deliveryCity: e.target.value }))} required /></label>
                      <label>Region<input value={orderForm.deliveryRegion} onChange={(e) => setOrderForm((o) => ({ ...o, deliveryRegion: e.target.value }))} required /></label>
                      <label>Digital address<input value={orderForm.deliveryDigitalAddress} onChange={(e) => setOrderForm((o) => ({ ...o, deliveryDigitalAddress: e.target.value }))} /></label>
                    </div>
                  </fieldset>
                )}

                <label className="customer-consent"><input type="checkbox" checked={profileForm.termsAccepted} onChange={(e) => setProfileForm((p) => ({ ...p, termsAccepted: e.target.checked }))} required /> I accept the order and medicine-safety terms.</label>
                <label className="customer-consent"><input type="checkbox" checked={profileForm.privacyConsent} onChange={(e) => setProfileForm((p) => ({ ...p, privacyConsent: e.target.checked }))} required /> I consent to pharmacist review of the submitted information.</label>

                <div className="customer-checkout-total">
                  <span>Estimated total</span>
                  <strong>{currency(Number(orderForm.quantity || 0) * Number(selectedListing.price || 0))}</strong>
                </div>
                <div className="form-actions">
                  <button className="btn btn-outline" type="button" onClick={() => setSelectedListing(null)}>Cancel</button>
                  <button className="btn btn-primary" type="submit" disabled={busy === 'order'}>
                    {busy === 'order' ? 'Submitting...' : 'Send for pharmacist review'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default CustomerEPharmacy
