import { jsPDF } from 'jspdf'
import { formatAppDateTime } from '../utils/date'
import {
  PLATFORM_GENERATED_BY,
  getFacilityName,
  getFacilityWebsite,
  getReceiptFooter,
} from '../utils/facilityBranding'

/**
 * Receipt Service
 * Handles receipt generation, printing, and PDF export
 */

/**
 * Format currency with symbol
 */
const formatCurrency = (amount, currency = 'GHS') => {
  return `${currency} ${Number(amount).toFixed(2)}`
}

/**
 * Format date for receipt
 */
const formatDate = (dateString) => {
  return formatAppDateTime(dateString, { hour12: true })
}

const getLogoImageFormat = (logoUrl) => {
  const match = String(logoUrl || '').match(/^data:image\/(png|jpe?g|webp);/i)
  if (!match) return null
  const format = match[1].toLowerCase()
  if (format === 'jpg' || format === 'jpeg') return 'JPEG'
  if (format === 'webp') return 'WEBP'
  return 'PNG'
}

const addReceiptLogo = (doc, logoUrl, x, y, size) => {
  const format = getLogoImageFormat(logoUrl)
  if (!format) return false

  try {
    doc.addImage(logoUrl, format, x, y, size, size)
    return true
  } catch (error) {
    console.warn('Unable to add facility logo to receipt PDF:', error)
    return false
  }
}

/**
 * Generate PDF receipt
 */
export const generateReceiptPDF = (saleData, pharmacyInfo) => {
  const doc = new jsPDF({
    unit: 'mm',
    format: 'a4',
  })

  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 20
  const currency = pharmacyInfo?.currency || 'GHS'
  const pharmacySlogan = String(pharmacyInfo?.slogan || '').trim()
  const facilityName = getFacilityName(pharmacyInfo)
  const facilityWebsite = getFacilityWebsite(pharmacyInfo)
  const receiptFooter = getReceiptFooter(pharmacyInfo)
  let y = 18

  const green = [8, 119, 92]
  const dark = [16, 32, 51]
  const gray = [93, 108, 128]
  const mint = [234, 248, 244]

  const setColor = (value) => doc.setTextColor(value[0], value[1], value[2])
  const money = (amount) => formatCurrency(amount, currency)
  const rightText = (text, x, yPos) => {
    doc.text(text, x - doc.getTextWidth(text), yPos)
  }
  const labelValue = (label, value, x, yPos, width = 55) => {
    doc.setFont('helvetica', 'normal')
    setColor(gray)
    doc.text(label, x, yPos)
    doc.setFont('helvetica', 'bold')
    setColor(dark)
    doc.text(String(value || ''), x + width, yPos)
  }

  doc.setFont('helvetica', 'bold')
  setColor(green)
  doc.setFontSize(22)
  doc.text(facilityName, margin + 18, y + 10)
  if (pharmacySlogan) {
    doc.setFont('helvetica', 'normal')
    setColor(gray)
    doc.setFontSize(9)
    doc.text(pharmacySlogan, margin + 18, y + 16)
  }
  doc.setFillColor(...green)
  doc.roundedRect(margin, y, 14, 14, 3, 3, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(14)
  doc.text('+', margin + 4.7, y + 9.9)
  setColor(green)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  rightText('THANK YOU', pageWidth - margin, y + 8)
  doc.setFont('helvetica', 'normal')
  setColor(gray)
  rightText('For choosing us!', pageWidth - margin, y + 15)
  y += 30
  doc.setDrawColor(215, 227, 223)
  doc.line(margin, y, pageWidth - margin, y)

  y += 14
  if (addReceiptLogo(doc, pharmacyInfo?.logo_url, pageWidth / 2 - 10, y - 4, 20)) {
    y += 22
  }
  setColor(green)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(facilityName, pageWidth / 2, y, {
    align: 'center',
  })
  y += 8
  if (pharmacySlogan) {
    setColor(gray)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.text(pharmacySlogan, pageWidth / 2, y, { align: 'center' })
    y += 6
  }
  setColor(dark)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  const contactLines = [
    [pharmacyInfo?.address, pharmacyInfo?.city, pharmacyInfo?.region].filter(Boolean).join(', '),
    pharmacyInfo?.phone,
    pharmacyInfo?.email,
    facilityWebsite,
  ].filter(Boolean)
  contactLines.forEach((line) => {
    doc.text(line, pageWidth / 2, y, { align: 'center' })
    y += 6
  })

  y += 6
  doc.setDrawColor(196, 211, 207)
  doc.setLineDashPattern([2, 2], 0)
  doc.line(margin, y, pageWidth - margin, y)
  doc.setLineDashPattern([], 0)

  y += 14
  labelValue('Receipt / Sale #:', saleData.saleNumber, margin, y, 42)
  labelValue('Date:', formatDate(saleData.saleDate), margin, y + 9, 42)
  if (saleData.soldBy) {
    labelValue('Cashier:', saleData.soldBy, margin, y + 18, 42)
  }
  if (saleData.patient) {
    labelValue('Patient:', saleData.patient.full_name, margin, y + 27, 42)
  }
  doc.setDrawColor(215, 227, 223)
  doc.line(pageWidth - 68, y - 3, pageWidth - 68, y + 28)
  doc.setFillColor(...mint)
  doc.roundedRect(pageWidth - 54, y, 18, 18, 3, 3, 'F')
  setColor(green)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.text('Sales Receipt', pageWidth - 58, y + 28)

  y += 43
  setColor(green)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('ITEMS', margin, y)
  y += 8
  doc.setFillColor(...mint)
  doc.roundedRect(margin, y, pageWidth - margin * 2, 11, 2, 2, 'F')
  setColor(green)
  doc.setFontSize(9)
  doc.text('#', margin + 5, y + 7)
  doc.text('Item', margin + 18, y + 7)
  doc.text('Qty', pageWidth - 76, y + 7)
  doc.text('Unit Price', pageWidth - 56, y + 7)
  rightText('Total', pageWidth - margin - 4, y + 7)
  y += 18

  setColor(dark)
  doc.setFontSize(9)
  saleData.items.forEach((item, index) => {
    const itemName = item.drug_name || item.name
    const unitPrice = item.unit_price || item.price
    const totalPrice = item.total_price || item.quantity * item.price
    doc.setFont('helvetica', 'normal')
    doc.text(String(index + 1), margin + 5, y)
    doc.setFont('helvetica', 'bold')
    doc.text(doc.splitTextToSize(itemName, 76), margin + 18, y)
    doc.text(String(item.quantity), pageWidth - 76, y)
    doc.text(money(unitPrice), pageWidth - 56, y)
    setColor(green)
    rightText(money(totalPrice), pageWidth - margin - 4, y)
    setColor(dark)
    y += Math.max(10, doc.splitTextToSize(itemName, 76).length * 5)
    doc.setDrawColor(230, 236, 233)
    doc.line(margin, y - 4, pageWidth - margin, y - 4)
  })

  const totalsX = pageWidth - 82
  y += 2
  labelValue('Subtotal', money(saleData.totalAmount), totalsX, y, 36)
  labelValue('Discount', money(saleData.discount || 0), totalsX, y + 8, 36)
  labelValue('Tax', money(0), totalsX, y + 16, 36)
  y += 25
  doc.setFillColor(...mint)
  doc.roundedRect(margin, y, pageWidth - margin * 2, 14, 2, 2, 'F')
  setColor(green)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('TOTAL COST', margin + 4, y + 9)
  doc.setFontSize(14)
  rightText(money(saleData.netAmount), pageWidth - margin - 4, y + 9)

  y += 27
  doc.setFontSize(12)
  doc.text('PAYMENT DETAILS', margin, y)
  y += 7
  doc.setDrawColor(184, 222, 211)
  const insuranceDetails = saleData.insuranceDetails
  const nhisCoveredAmount = Number(insuranceDetails?.coveredAmount || 0)
  const nhisTopUpAmount = Number(insuranceDetails?.patientTopUp || 0)
  const privateNonNhisAmount = Number(insuranceDetails?.privateNonNhisAmount || 0)
  const policyAdjustmentAmount = Number(insuranceDetails?.policyAdjustmentAmount || 0)
  const isNhisSettlement = String(saleData.paymentMethod || '').toLowerCase() === 'nhia'
    || nhisCoveredAmount > 0
    || privateNonNhisAmount > 0
    || policyAdjustmentAmount > 0
  const paymentRows = [
    ['Payment Mode', saleData.paymentMethod?.toUpperCase() || 'N/A'],
    ['Amount Paid', money(saleData.amountPaid)],
    ['Change', money(saleData.change || 0)],
  ]
  if (insuranceDetails) {
    paymentRows.push(['Insurance Provider', insuranceDetails.provider || 'N/A'])
    if (insuranceDetails.insuranceId) paymentRows.push(['Insurance ID', insuranceDetails.insuranceId])
    if (nhisCoveredAmount > 0) paymentRows.push([isNhisSettlement ? 'NHIS Covered' : 'Insurance Covered', money(nhisCoveredAmount)])
    if (nhisTopUpAmount > 0) paymentRows.push([isNhisSettlement ? 'NHIS Top-Up' : 'Patient Top-Up', money(nhisTopUpAmount)])
    if (privateNonNhisAmount > 0) paymentRows.push(['Private / Non-NHIS', money(privateNonNhisAmount)])
    if (policyAdjustmentAmount > 0) paymentRows.push(['NHIS Policy Adjustment', money(policyAdjustmentAmount)])
    if (Number(insuranceDetails.patientDueAmount || 0) > 0) paymentRows.push(['Patient Paid', money(insuranceDetails.patientDueAmount)])
    if (insuranceDetails.patientTopUpMethod) paymentRows.push(['Top-Up Paid By', insuranceDetails.patientTopUpMethod.toUpperCase()])
  }
  const paymentDetailsHeight = Math.max(34, paymentRows.length * 9 + 10)
  doc.roundedRect(margin, y, pageWidth - margin * 2, paymentDetailsHeight, 2, 2)
  paymentRows.forEach(([label, value], index) => labelValue(label, value, margin + 34, y + 11 + index * 9, 62))

  y += paymentDetailsHeight + 14
  doc.setDrawColor(196, 211, 207)
  doc.setLineDashPattern([2, 2], 0)
  doc.line(margin, y, pageWidth - margin, y)
  doc.setLineDashPattern([], 0)

  y += 18
  setColor(green)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('Thank you for your patronage!', pageWidth / 2, y, { align: 'center' })
  y += 8
  setColor(gray)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text('Please keep this receipt for your records.', pageWidth / 2, y, { align: 'center' })
  if (receiptFooter) {
    y += 7
    doc.text(receiptFooter, pageWidth / 2, y, { align: 'center' })
  }
  y += 12
  doc.text(`Printed: ${formatAppDateTime(new Date(), { hour12: true })}`, pageWidth / 2, y, {
    align: 'center',
  })
  y += 8
  doc.setFontSize(8)
  doc.text(PLATFORM_GENERATED_BY, pageWidth / 2, y, {
    align: 'center',
  })

  doc.setFillColor(...green)
  doc.rect(0, pageHeight - 18, pageWidth, 18, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.text(receiptFooter || 'Your health is our priority.', pageWidth / 2, pageHeight - 7, { align: 'center' })

  return doc
}

/**
 * Download receipt as PDF
 */
export const downloadReceiptPDF = (saleData, pharmacyInfo) => {
  const doc = generateReceiptPDF(saleData, pharmacyInfo)
  const fileName = `Receipt-${saleData.saleNumber}.pdf`
  doc.save(fileName)
}

/**
 * Print receipt using browser print dialog
 */
export const printReceipt = () => {
  // Small delay to ensure receipt is rendered
  setTimeout(() => {
    window.print()
  }, 100)
}

/**
 * Get receipt data from sale
 */
export const formatSaleForReceipt = (sale, items, patient = null, soldByName = null) => {
  const nhisCoveredAmount = Number(sale.nhis_covered_amount ?? sale.nhisCoveredAmount ?? 0)
  const nhisTopUpAmount = Number(sale.nhis_top_up_amount ?? sale.nhisTopUpAmount ?? 0)
  const privateNonNhisAmount = Number(sale.private_non_nhis_amount ?? sale.privateNonNhisAmount ?? 0)
  const policyAdjustmentAmount = Number(sale.nhis_policy_adjustment_amount ?? sale.nhisPolicyAdjustmentAmount ?? 0)
  const hasNhisSettlement = nhisCoveredAmount > 0 || nhisTopUpAmount > 0 || privateNonNhisAmount > 0 || policyAdjustmentAmount > 0

  return {
    saleNumber: sale.sale_number,
    saleDate: sale.sale_date || sale.created_at,
    items: items || sale.items || [],
    totalAmount: sale.total_amount,
    discount: sale.discount || 0,
    netAmount: sale.net_amount,
    paymentMethod: sale.payment_method || 'cash',
    amountPaid: sale.amount_paid,
    change: sale.change_given || 0,
    patient: patient,
    insuranceDetails: hasNhisSettlement
      ? {
          provider: patient?.insurance_provider || 'NHIS',
          insuranceId: patient?.insurance_id || patient?.nhis_hin || null,
          coveredAmount: nhisCoveredAmount,
          patientTopUp: nhisTopUpAmount,
          privateNonNhisAmount,
          policyAdjustmentAmount,
          patientDueAmount: nhisTopUpAmount + privateNonNhisAmount,
          patientTopUpMethod: sale.patient_payment_method ?? sale.patientPaymentMethod ?? null,
        }
      : null,
    soldBy: soldByName,
  }
}
