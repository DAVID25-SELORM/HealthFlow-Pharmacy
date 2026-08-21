import { forwardRef } from 'react'
import { Briefcase, CreditCard, HeartPulse, Mail, MapPin, Phone, Printer, ReceiptText, ShoppingBag } from 'lucide-react'
import { formatAppDateTime } from '../../utils/date'
import {
  PLATFORM_GENERATED_BY,
  getFacilityName,
  getFacilityWebsite,
  getReceiptFooter,
} from '../../utils/facilityBranding'
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
    insuranceDetails,
    soldBy,
  } = saleData

  const formatCurrency = (amount) => {
    const currency = pharmacyInfo?.currency || 'GHS'
    return `${currency} ${Number(amount).toFixed(2)}`
  }

  const formatDate = (dateString) => {
    return formatAppDateTime(dateString, { hour12: true })
  }

  const printedAt = formatAppDateTime(new Date(), { hour12: true })
  const pharmacySlogan = String(pharmacyInfo?.slogan || '').trim()
  const facilityName = getFacilityName(pharmacyInfo)
  const facilityWebsite = getFacilityWebsite(pharmacyInfo)
  const receiptFooter = getReceiptFooter(pharmacyInfo)
  const insuranceCoveredAmount = Number(insuranceDetails?.coveredAmount || 0)
  const patientTopUpAmount = Number(insuranceDetails?.patientTopUp || 0)
  const privateNonNhisAmount = Number(insuranceDetails?.privateNonNhisAmount || 0)
  const policyAdjustmentAmount = Number(insuranceDetails?.policyAdjustmentAmount || 0)
  const isNhisSettlement = String(paymentMethod || '').toLowerCase() === 'nhia'
    || insuranceCoveredAmount > 0
    || privateNonNhisAmount > 0
    || policyAdjustmentAmount > 0

  return (
    <div ref={ref} className={`receipt-container receipt-${mode}-mode`}>
      <div className="receipt-content">
        <header className="receipt-brand">
          <div className="brand-left">
            <div className="brand-mark" aria-hidden="true">
              <HeartPulse size={34} />
            </div>
            <div>
              <h2>{facilityName}</h2>
              {pharmacySlogan && <p>{pharmacySlogan}</p>}
            </div>
          </div>
          <div className="brand-thanks">
            <Briefcase size={34} />
            <strong>THANK YOU</strong>
            <span>For choosing us!</span>
          </div>
        </header>

        <section className="receipt-pharmacy-card">
          {pharmacyInfo?.logo_url && (
            <img src={pharmacyInfo.logo_url} alt="" className="receipt-pharmacy-logo" />
          )}
          <h3>{facilityName}</h3>
          {pharmacySlogan && <p className="receipt-slogan">{pharmacySlogan}</p>}
          <div className="pharmacy-contact">
            {pharmacyInfo?.address && (
              <span>
                <MapPin size={15} />
                {pharmacyInfo.address}
                {pharmacyInfo?.city || pharmacyInfo?.region
                  ? `, ${[pharmacyInfo.city, pharmacyInfo.region].filter(Boolean).join(', ')}`
                  : ''}
              </span>
            )}
            {pharmacyInfo?.phone && (
              <span>
                <Phone size={15} />
                {pharmacyInfo.phone}
              </span>
            )}
            {pharmacyInfo?.email && (
              <span>
                <Mail size={15} />
                {pharmacyInfo.email}
              </span>
            )}
            {facilityWebsite && (
              <span>
                <Briefcase size={15} />
                {facilityWebsite}
              </span>
            )}
          </div>
        </section>

        <div className="receipt-dashed" />

        <section className="receipt-sale-strip">
          <div className="sale-meta">
            <div>
              <span>Receipt / Sale #:</span>
              <strong>{saleNumber}</strong>
            </div>
            <div>
              <span>Date:</span>
              <strong>{formatDate(saleDate)}</strong>
            </div>
            {soldBy && (
              <div>
                <span>Cashier:</span>
                <strong>{soldBy}</strong>
              </div>
            )}
            {patient && (
              <div>
                <span>Patient:</span>
                <strong>
                  {patient.full_name} {patient.phone && `(${patient.phone})`}
                </strong>
              </div>
            )}
          </div>
          <div className="sale-type">
            <ReceiptText size={38} />
            <span>Sales Receipt</span>
          </div>
        </section>

        <section className="receipt-items">
          <div className="section-title">
            <ShoppingBag size={22} />
            <span>ITEMS</span>
          </div>
          <table className="receipt-items-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Item</th>
                <th>Qty</th>
                <th>Unit Price</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const name = item.drug_name || item.name
                const unitPrice = item.unit_price || item.price
                const totalPrice = item.total_price || item.quantity * item.price
                return (
                  <tr key={`${name}-${index}`}>
                    <td>{index + 1}</td>
                    <td>
                      <strong>{name}</strong>
                      {item.unit && <span>{item.unit}</span>}
                    </td>
                    <td>{item.quantity}</td>
                    <td>{formatCurrency(unitPrice)}</td>
                    <td>
                      <strong>{formatCurrency(totalPrice)}</strong>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        <section className="receipt-summary">
          <div className="receipt-total-lines">
            <div>
              <span>Subtotal</span>
              <strong>{formatCurrency(totalAmount)}</strong>
            </div>
            <div>
              <span>Discount</span>
              <strong>{formatCurrency(discount || 0)}</strong>
            </div>
            <div>
              <span>Tax</span>
              <strong>{formatCurrency(0)}</strong>
            </div>
          </div>
          <div className="receipt-grand-total">
            <span>TOTAL COST</span>
            <strong>{formatCurrency(netAmount)}</strong>
          </div>
        </section>

        <section className="receipt-payment">
          <div className="section-title">
            <CreditCard size={22} />
            <span>PAYMENT DETAILS</span>
          </div>
          <div className="payment-card">
            <div className="payment-icon" aria-hidden="true">
              <CreditCard size={42} />
            </div>
            <div className="payment-lines">
              <div>
                <span>Payment Mode</span>
                <strong>{paymentMethod ? paymentMethod.toUpperCase() : 'N/A'}</strong>
              </div>
              <div>
                <span>Amount Paid</span>
                <strong>{formatCurrency(amountPaid)}</strong>
              </div>
              <div>
                <span>Change</span>
                <strong>{formatCurrency(change || 0)}</strong>
              </div>
              {insuranceDetails && (
                <>
                  <div>
                    <span>Insurance Provider</span>
                    <strong>{insuranceDetails.provider}</strong>
                  </div>
                  <div>
                    <span>Insurance ID</span>
                    <strong>{insuranceDetails.insuranceId}</strong>
                  </div>
                  {insuranceCoveredAmount > 0 && (
                    <div>
                      <span>{isNhisSettlement ? 'NHIS Covered' : 'Insurance Covered'}</span>
                      <strong>{formatCurrency(insuranceCoveredAmount)}</strong>
                    </div>
                  )}
                  {patientTopUpAmount > 0 && (
                    <div>
                      <span>{isNhisSettlement ? 'NHIS Top-Up' : 'Patient Top-Up'}</span>
                      <strong>{formatCurrency(patientTopUpAmount)}</strong>
                    </div>
                  )}
                  {privateNonNhisAmount > 0 && (
                    <div>
                      <span>Private / Non-NHIS</span>
                      <strong>{formatCurrency(privateNonNhisAmount)}</strong>
                    </div>
                  )}
                  {policyAdjustmentAmount > 0 && (
                    <div>
                      <span>NHIS Policy Adjustment</span>
                      <strong>{formatCurrency(policyAdjustmentAmount)}</strong>
                    </div>
                  )}
                  {insuranceDetails.patientDueAmount !== undefined && (
                    <div>
                      <span>Patient Paid</span>
                      <strong>{formatCurrency(insuranceDetails.patientDueAmount)}</strong>
                    </div>
                  )}
                  {insuranceDetails.patientTopUpMethod && (
                    <div>
                      <span>Top-Up Paid By</span>
                      <strong>{insuranceDetails.patientTopUpMethod.toUpperCase()}</strong>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </section>

        <div className="receipt-dashed" />

        <footer className="receipt-footer">
          <div className="footer-message">
            <p className="thank-you">Thank you for your patronage!</p>
            <p className="footer-note">Please keep this receipt for your records.</p>
            {receiptFooter && <p className="custom-footer">{receiptFooter}</p>}
            <p className="print-timestamp">
              <Printer size={14} />
              Printed: {printedAt}
            </p>
          </div>
        </footer>

        <div className="receipt-bottom-bar">
          <span>{receiptFooter || 'Your health is our priority.'}</span>
          <HeartPulse size={26} />
        </div>

        <div className="receipt-developer-credit">
          <p>{PLATFORM_GENERATED_BY}</p>
        </div>
      </div>
    </div>
  )
})

Receipt.displayName = 'Receipt'

export default Receipt
