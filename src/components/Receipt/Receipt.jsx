import { forwardRef } from 'react'
import './Receipt.css'

const Receipt = forwardRef(({ saleData, pharmacyInfo, mode = 'preview' }, ref) => {
  const {
    saleNumber,
    saleDate,
    items,
    totalAmount,
    discount,
    netAmount,
    paymentMethod,
    amountPaid,
    change,
    patient,
    soldBy,
  } = saleData

  const formatCurrency = (amount) => {
    const currency = pharmacyInfo?.currency || 'GHS'
    return `${currency} ${Number(amount).toFixed(2)}`
  }

  const formatDate = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  }

  return (
    <div ref={ref} className={`receipt-container receipt-${mode}-mode`}>
      <div className="receipt-content">
        {/* Header */}
        <div className="receipt-header">
          <h2>{pharmacyInfo?.pharmacy_name || 'HealthFlow Pharmacy'}</h2>
          {pharmacyInfo?.address && <p>{pharmacyInfo.address}</p>}
          {pharmacyInfo?.city && pharmacyInfo?.region && (
            <p>
              {pharmacyInfo.city}, {pharmacyInfo.region}
            </p>
          )}
          {pharmacyInfo?.phone && <p>Phone: {pharmacyInfo.phone}</p>}
          {pharmacyInfo?.email && <p>Email: {pharmacyInfo.email}</p>}
          {pharmacyInfo?.license_number && (
            <p className="license">License No: {pharmacyInfo.license_number}</p>
          )}
        </div>

        <div className="receipt-divider">{'='.repeat(45)}</div>

        {/* Sale Info */}
        <div className="receipt-info">
          <div className="info-row">
            <span>Sale #:</span>
            <span className="bold">{saleNumber}</span>
          </div>
          <div className="info-row">
            <span>Date:</span>
            <span>{formatDate(saleDate)}</span>
          </div>
          {soldBy && (
            <div className="info-row">
              <span>Cashier:</span>
              <span>{soldBy}</span>
            </div>
          )}
          {patient && (
            <div className="info-row">
              <span>Patient:</span>
              <span>
                {patient.full_name} {patient.phone && `(${patient.phone})`}
              </span>
            </div>
          )}
        </div>

        <div className="receipt-divider">{'-'.repeat(45)}</div>

        {/* Items */}
        <div className="receipt-items">
          <div className="items-header">ITEMS</div>
          {items.map((item, index) => (
            <div key={index} className="receipt-item">
              <div className="item-name">{item.drug_name || item.name}</div>
              <div className="item-details">
                <span>
                  Qty: {item.quantity} x {formatCurrency(item.unit_price || item.price)}
                </span>
                <span className="item-total">
                  {formatCurrency(item.total_price || item.quantity * item.price)}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="receipt-divider">{'-'.repeat(45)}</div>

        {/* Totals */}
        <div className="receipt-totals">
          <div className="total-row">
            <span>Subtotal:</span>
            <span>{formatCurrency(totalAmount)}</span>
          </div>
          {discount > 0 && (
            <div className="total-row">
              <span>Discount:</span>
              <span>-{formatCurrency(discount)}</span>
            </div>
          )}
          <div className="receipt-divider">{'-'.repeat(45)}</div>
          <div className="total-row grand-total">
            <span>TOTAL:</span>
            <span>{formatCurrency(netAmount)}</span>
          </div>

          <div className="payment-section">
            <div className="total-row">
              <span>Payment:</span>
              <span className="payment-method">{paymentMethod ? paymentMethod.toUpperCase() : 'N/A'}</span>
            </div>
            <div className="total-row">
              <span>Paid:</span>
              <span>{formatCurrency(amountPaid)}</span>
            </div>
            {change > 0 && (
              <div className="total-row change-row">
                <span>Change:</span>
                <span>{formatCurrency(change)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="receipt-divider">{'='.repeat(45)}</div>

        {/* Footer */}
        <div className="receipt-footer">
          <p className="thank-you">Thank you for your patronage!</p>
          <p className="footer-note">Please keep this receipt for your records</p>
          {pharmacyInfo?.receipt_footer && (
            <p className="custom-footer">{pharmacyInfo.receipt_footer}</p>
          )}
        </div>

        {/* Print timestamp */}
        <div className="print-timestamp">
          <p>Printed: {new Date().toLocaleString('en-GB')}</p>
        </div>
      </div>
    </div>
  )
})

Receipt.displayName = 'Receipt'

export default Receipt
