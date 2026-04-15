import { jsPDF } from 'jspdf'

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

/**
 * Generate PDF receipt
 */
export const generateReceiptPDF = (saleData, pharmacyInfo) => {
  const doc = new jsPDF({
    unit: 'mm',
    format: [80, 297], // 80mm wide (thermal printer standard), auto height
  })

  const pageWidth = 80
  const margin = 5
  const contentWidth = pageWidth - 2 * margin
  let y = 10

  // Set default font
  doc.setFont('courier', 'normal')
  doc.setFontSize(10)

  // Helper to add centered text
  const addCenteredText = (text, yPos, fontSize = 10, style = 'normal') => {
    doc.setFontSize(fontSize)
    doc.setFont('courier', style)
    const textWidth = doc.getTextWidth(text)
    doc.text(text, (pageWidth - textWidth) / 2, yPos)
  }

  // Helper to add line
  const addLine = (char = '=', yPos) => {
    const line = char.repeat(Math.floor(contentWidth / 1.5))
    addCenteredText(line, yPos, 8)
  }

  // Header
  addCenteredText(pharmacyInfo?.pharmacy_name || 'HealthFlow Pharmacy', y, 12, 'bold')
  y += 5

  if (pharmacyInfo?.address) {
    addCenteredText(pharmacyInfo.address, y, 8)
    y += 4
  }

  if (pharmacyInfo?.city && pharmacyInfo?.region) {
    addCenteredText(`${pharmacyInfo.city}, ${pharmacyInfo.region}`, y, 8)
    y += 4
  }

  if (pharmacyInfo?.phone) {
    addCenteredText(`Phone: ${pharmacyInfo.phone}`, y, 8)
    y += 4
  }

  if (pharmacyInfo?.email) {
    addCenteredText(`Email: ${pharmacyInfo.email}`, y, 8)
    y += 4
  }

  if (pharmacyInfo?.license_number) {
    addCenteredText(`License: ${pharmacyInfo.license_number}`, y, 7, 'italic')
    y += 4
  }

  y += 2
  addLine('=', y)
  y += 5

  // Sale Info
  doc.setFontSize(9)
  doc.setFont('courier', 'normal')
  doc.text(`Sale #: ${saleData.saleNumber}`, margin, y)
  y += 4
  doc.text(`Date: ${formatDate(saleData.saleDate)}`, margin, y)
  y += 4

  if (saleData.soldBy) {
    doc.text(`Cashier: ${saleData.soldBy}`, margin, y)
    y += 4
  }

  if (saleData.patient) {
    const patientText = `Patient: ${saleData.patient.full_name}`
    doc.text(patientText, margin, y)
    y += 4
    if (saleData.patient.phone) {
      doc.text(`  ${saleData.patient.phone}`, margin, y)
      y += 4
    }
  }

  y += 1
  addLine('-', y)
  y += 5

  // Items header
  addCenteredText('ITEMS', y, 10, 'bold')
  y += 5

  // Items
  doc.setFontSize(8)
  saleData.items.forEach((item) => {
    const itemName = item.drug_name || item.name
    const unitPrice = item.unit_price || item.price
    const totalPrice = item.total_price || item.quantity * item.price

    // Item name
    doc.setFont('courier', 'bold')
    doc.text(itemName, margin, y)
    y += 3.5

    // Quantity and price
    doc.setFont('courier', 'normal')
    const qtyText = `Qty: ${item.quantity} x ${formatCurrency(unitPrice, pharmacyInfo?.currency || 'GHS')}`
    doc.text(qtyText, margin + 2, y)

    const totalText = formatCurrency(totalPrice, pharmacyInfo?.currency || 'GHS')
    const totalWidth = doc.getTextWidth(totalText)
    doc.text(totalText, pageWidth - margin - totalWidth, y)
    y += 5
  })

  addLine('-', y)
  y += 5

  // Totals
  doc.setFontSize(9)
  const currency = pharmacyInfo?.currency || 'GHS'

  const addTotal = (label, amount, bold = false) => {
    doc.setFont('courier', bold ? 'bold' : 'normal')
    doc.text(label, margin, y)
    const amountText = formatCurrency(amount, currency)
    const amountWidth = doc.getTextWidth(amountText)
    doc.text(amountText, pageWidth - margin - amountWidth, y)
    y += 4
  }

  addTotal('Subtotal:', saleData.totalAmount)
  
  if (saleData.discount > 0) {
    addTotal('Discount:', -saleData.discount)
  }

  addLine('-', y)
  y += 4

  addTotal('TOTAL:', saleData.netAmount, true)
  y += 2

  // Payment
  doc.setFont('courier', 'normal')
  const paymentMethodText = saleData.paymentMethod ? saleData.paymentMethod.toUpperCase() : 'N/A'
  doc.text(`Payment: ${paymentMethodText}`, margin, y)
  y += 4

  addTotal('Paid:', saleData.amountPaid)
  
  if (saleData.change > 0) {
    addTotal('Change:', saleData.change, true)
  }

  y += 1
  addLine('=', y)
  y += 5

  // Footer
  addCenteredText('Thank you for your patronage!', y, 9, 'bold')
  y += 5
  addCenteredText('Please keep this receipt', y, 7, 'italic')
  y += 4

  if (pharmacyInfo?.receipt_footer) {
    addCenteredText(pharmacyInfo.receipt_footer, y, 7)
    y += 4
  }

  y += 2
  addCenteredText(`Printed: ${new Date().toLocaleString('en-GB')}`, y, 6)

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
