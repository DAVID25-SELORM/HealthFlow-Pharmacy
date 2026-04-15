import { useEffect, useMemo, useState, useRef } from 'react'
import { Search, Trash2, Plus, Minus, ShoppingCart, Printer, Download, X } from 'lucide-react'
import { getAllDrugs } from '../services/drugService'
import { createSale } from '../services/salesService'
import { getAllPatients } from '../services/patientService'
import { getPharmacySettings } from '../services/settingsService'
import { printReceipt, downloadReceiptPDF, formatSaleForReceipt } from '../services/receiptService'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import Receipt from '../components/Receipt/Receipt'
import './Sales.css'

const Sales = () => {
  const { user } = useAuth()
  const { notify } = useNotification()
  const [drugs, setDrugs] = useState([])
  const [patients, setPatients] = useState([])
  const [cart, setCart] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [patientId, setPatientId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [received, setReceived] = useState('')
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [lastSale, setLastSale] = useState(null)
  const [showReceipt, setShowReceipt] = useState(false)
  const [pharmacyInfo, setPharmacyInfo] = useState(null)
  const receiptRef = useRef()

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        setError('')

        if (!isSupabaseConfigured()) {
          setError('Supabase is not configured. Update .env to enable sales.')
          return
        }

        const [drugsData, patientsData, pharmacySettings] = await Promise.all([
          getAllDrugs(),
          getAllPatients(),
          getPharmacySettings().catch(() => null),
        ])
        setDrugs(drugsData)
        setPatients(patientsData)
        setPharmacyInfo(pharmacySettings)
      } catch (loadError) {
        console.error('Error loading POS data:', loadError)
        setError(loadError.message || 'Unable to load POS data.')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [])

  const filteredDrugs = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) {
      return drugs
    }
    return drugs.filter((drug) => {
      return (
        drug.name.toLowerCase().includes(term) ||
        String(drug.batch_number || '').toLowerCase().includes(term)
      )
    })
  }, [drugs, searchTerm])

  const cartCount = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  )

  const calculateTotal = () => {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
  }

  const calculateChange = () => {
    const total = calculateTotal()
    const receivedAmount = Number.parseFloat(received) || 0
    return Math.max(0, receivedAmount - total)
  }

  const getReservedQty = (drugId) => {
    const row = cart.find((item) => item.id === drugId)
    return row?.quantity || 0
  }

  const addToCart = (drug) => {
    setCart((current) => {
      const existing = current.find((item) => item.id === drug.id)
      const maxQty = Number.parseFloat(drug.quantity) || 0

      if (existing) {
        if (existing.quantity >= maxQty) {
          return current
        }
        return current.map((item) =>
          item.id === drug.id ? { ...item, quantity: item.quantity + 1 } : item
        )
      }

      if (maxQty <= 0) {
        return current
      }

      return [
        ...current,
        {
          id: drug.id,
          drugId: drug.id,
          name: drug.name,
          price: Number.parseFloat(drug.price),
          quantity: 1,
          available: maxQty,
        },
      ]
    })
  }

  const updateQuantity = (id, change) => {
    setCart((current) =>
      current
        .map((item) => {
          if (item.id !== id) {
            return item
          }
          const nextQty = item.quantity + change
          if (nextQty <= 0) {
            return null
          }
          if (nextQty > item.available) {
            return item
          }
          return { ...item, quantity: nextQty }
        })
        .filter(Boolean)
    )
  }

  const setItemQuantity = (id, rawValue, available) => {
    const value = parseInt(rawValue, 10)
    if (Number.isNaN(value) || value <= 0) {
      setCart((current) => current.filter((item) => item.id !== id))
      return
    }
    const clamped = Math.min(value, available)
    setCart((current) =>
      current.map((item) => (item.id === id ? { ...item, quantity: clamped } : item))
    )
  }

  const removeItem = (id) => {
    setCart((current) => current.filter((item) => item.id !== id))
  }

  const refreshDrugs = async () => {
    try {
      const latestDrugs = await getAllDrugs()
      setDrugs(latestDrugs)
    } catch (refreshError) {
      console.error('Failed to refresh inventory:', refreshError)
    }
  }

  const handleCompleteSale = async () => {
    if (!cart.length) {
      return
    }

    const total = calculateTotal()
    const amountPaid = Number.parseFloat(received) || 0

    if (paymentMethod === 'cash' && amountPaid < total) {
      notify('Received amount must be at least the total for cash payments.', 'warning')
      return
    }

    try {
      setProcessing(true)
      setError('')

      const saleResult = await createSale({
        items: cart.map((item) => ({
          drugId: item.drugId,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
        })),
        patientId: patientId || null,
        paymentMethod,
        amountPaid: paymentMethod === 'cash' ? amountPaid : total,
        change: paymentMethod === 'cash' ? calculateChange() : 0,
        soldBy: user?.id || null,
      })

      // Prepare receipt data
      const selectedPatient = patientId ? patients.find((p) => p.id === patientId) : null
      const receiptData = formatSaleForReceipt(
        saleResult,
        cart,
        selectedPatient,
        user?.full_name || user?.email
      )
      setLastSale(receiptData)

      // Clear cart
      setCart([])
      setSearchTerm('')
      setReceived('')
      setPatientId('')
      await refreshDrugs()
      
      notify('Sale completed successfully.', 'success')
      
      // Show receipt modal
      setShowReceipt(true)
    } catch (saleError) {
      console.error('Error completing sale:', saleError)
      setError(saleError.message || 'Unable to complete sale.')
    } finally {
      setProcessing(false)
    }
  }

  const handlePrintReceipt = () => {
    printReceipt()
  }

  const handleDownloadPDF = () => {
    if (lastSale) {
      downloadReceiptPDF(lastSale, pharmacyInfo)
      notify('Receipt PDF downloaded successfully.', 'success')
    }
  }

  const closeReceiptModal = () => {
    setShowReceipt(false)
  }

  const total = calculateTotal()
  const change = calculateChange()

  if (loading) {
    return (
      <div className="sales-page">
        <div className="page-header">
          <h1>Loading POS...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="sales-page">
      {/* Hidden Receipt for Printing */}
      {lastSale && <Receipt ref={receiptRef} saleData={lastSale} pharmacyInfo={pharmacyInfo} />}

      {/* Receipt Modal */}
      {showReceipt && lastSale && (
        <div className="receipt-modal-overlay">
          <div className="receipt-modal">
            <div className="receipt-modal-header">
              <h3>Receipt - {lastSale.saleNumber}</h3>
              <button onClick={closeReceiptModal} className="close-btn" aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className="receipt-preview">
              <Receipt saleData={lastSale} pharmacyInfo={pharmacyInfo} />
            </div>
            <div className="receipt-modal-actions">
              <button onClick={handlePrintReceipt} className="btn-print">
                <Printer size={18} />
                Print Receipt
              </button>
              <button onClick={handleDownloadPDF} className="btn-pdf">
                <Download size={18} />
                Download PDF
              </button>
              <button onClick={closeReceiptModal} className="btn-close-modal">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="page-header">
        <h1>Sales (POS)</h1>
        <p>Quick drug dispensing and checkout</p>
      </div>

      {error && <div className="pos-alert">{error}</div>}

      <div className="pos-layout">
        <div className="product-section">
          <div className="search-drug">
            <Search size={20} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search drug or batch number..."
            />
          </div>

          <div className="patient-select-card">
            <label htmlFor="sale-patient">Linked Patient (optional)</label>
            <select
              id="sale-patient"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            >
              <option value="">Walk-in customer</option>
              {patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.full_name} ({patient.phone})
                </option>
              ))}
            </select>
          </div>

          <div className="quick-add">
            <h3>Select Drugs</h3>
            <div className="drug-grid">
              {filteredDrugs.map((drug) => {
                const reserved = getReservedQty(drug.id)
                const remaining = Math.max(0, Number.parseFloat(drug.quantity || 0) - reserved)
                const soldOut = remaining <= 0

                return (
                  <button
                    key={drug.id}
                    className="drug-card"
                    onClick={() => addToCart(drug)}
                    disabled={soldOut}
                  >
                    <span className="drug-name">{drug.name}</span>
                    <span className="drug-price">GHS {Number.parseFloat(drug.price).toFixed(2)}</span>
                    <span className={`drug-stock ${soldOut ? 'sold-out' : ''}`}>
                      {soldOut ? 'Out of stock' : `${remaining} in stock`}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="checkout-section">
          <div className="cart-header">
            <h3>Selected Items</h3>
            <span className="item-count">{cartCount} items</span>
          </div>

          <div className="cart-items">
            {cart.length === 0 ? (
              <div className="empty-cart">
                <ShoppingCart size={48} />
                <p>No items in cart</p>
                <span>Search or select drugs to add</span>
              </div>
            ) : (
              cart.map((item) => (
                <div key={item.id} className="cart-item">
                  <div className="item-info">
                    <span className="item-name">{item.name}</span>
                    <span className="item-price">GHS {item.price.toFixed(2)}</span>
                  </div>
                  <div className="item-controls">
                    <div className="quantity-controls">
                      <button type="button" onClick={() => updateQuantity(item.id, -1)} aria-label="Decrease quantity">
                        <Minus size={18} />
                      </button>
                      <input
                        type="number"
                        className="quantity-input"
                        value={item.quantity}
                        min="1"
                        max={item.available}
                        onChange={(e) => setItemQuantity(item.id, e.target.value, item.available)}
                        aria-label={`Quantity for ${item.name}`}
                      />
                      <button type="button" onClick={() => updateQuantity(item.id, 1)} aria-label="Increase quantity">
                        <Plus size={18} />
                      </button>
                    </div>
                    <span className="item-total">GHS {(item.price * item.quantity).toFixed(2)}</span>
                    <button className="remove-btn" onClick={() => removeItem(item.id)}>
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="checkout-summary">
            <div className="total-section">
              <span className="total-label">Total</span>
              <span className="total-amount">GHS {total.toFixed(2)}</span>
            </div>

            <div className="payment-methods">
              <button
                className={`payment-btn ${paymentMethod === 'cash' ? 'active' : ''}`}
                onClick={() => setPaymentMethod('cash')}
              >
                Cash
              </button>
              <button
                className={`payment-btn ${paymentMethod === 'momo' ? 'active' : ''}`}
                onClick={() => setPaymentMethod('momo')}
              >
                Mobile Money
              </button>
              <button
                className={`payment-btn ${paymentMethod === 'insurance' ? 'active' : ''}`}
                onClick={() => setPaymentMethod('insurance')}
              >
                Insurance
              </button>
            </div>

            {paymentMethod === 'cash' && (
              <div className="cash-panel">
                <div className="cash-field cash-field-input">
                  <label htmlFor="cash-received">Cash Received</label>
                  <div className="cash-input-shell">
                    <span className="cash-prefix">GHS</span>
                    <input
                      id="cash-received"
                      type="number"
                      value={received}
                      onChange={(e) => setReceived(e.target.value)}
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                    />
                  </div>
                </div>
                <div className="cash-field cash-field-change">
                  <span className="cash-field-label">Change Due</span>
                  <span className="change-amount">GHS {change.toFixed(2)}</span>
                </div>
              </div>
            )}

            <button
              className="complete-sale-btn"
              disabled={cart.length === 0 || processing}
              onClick={handleCompleteSale}
            >
              {processing ? 'Completing Sale...' : 'Complete Sale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Sales
