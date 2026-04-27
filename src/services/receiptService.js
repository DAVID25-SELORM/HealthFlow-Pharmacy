import { jsPDF } from 'jspdf'
import { formatAppDateTime } from '../utils/date'

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
    console.warn('Unable to add pharmacy logo to receipt PDF:', error)
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
  doc.setFontSize(28)
  doc.text('HealthFlow', margin + 18, y + 10)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(13)
  doc.text('Pharmacy', margin + 18, y + 18)
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
  doc.text(pharmacyInfo?.pharmacy_name || 'HealthFlow Pharmacy', pageWidth / 2, y, {
    align: 'center',
  })
  y += 8
  setColor(dark)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  const contactLines = [
    [pharmacyInfo?.address, pharmacyInfo?.city, pharmacyInfo?.region].filter(Boolean).join(', '),
    pharmacyInfo?.phone,
    pharmacyInfo?.email,
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
  doc.roundedRect(margin, y, pageWidth - margin * 2, 34, 2, 2)
  labelValue('Payment Mode', saleData.paymentMethod?.toUpperCase() || 'N/A', margin + 34, y + 11, 62)
  labelValue('Amount Paid', money(saleData.amountPaid), margin + 34, y + 20, 62)
  labelValue('Change', money(saleData.change || 0), margin + 34, y + 29, 62)

  y += 48
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
  if (pharmacyInfo?.receipt_footer) {
    y += 7
    doc.text(pharmacyInfo.receipt_footer, pageWidth / 2, y, { align: 'center' })
  }
  y += 12
  doc.text(`Printed: ${formatAppDateTime(new Date(), { hour12: true })}`, pageWidth / 2, y, {
    align: 'center',
  })
  y += 8
  doc.setFontSize(8)
  doc.text('Software developed by Neon Digital Technologies Ltd.', pageWidth / 2, y, {
    align: 'center',
  })
  y += 4
  doc.text('neondigitaltechnologies@gmail.com', pageWidth / 2, y, {
    align: 'center',
  })

  doc.setFillColor(...green)
  doc.rect(0, pageHeight - 18, pageWidth, 18, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.text('Your health is our priority.', pageWidth / 2, pageHeight - 7, { align: 'center' })

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
    soldBy: soldByName,
  }
}
