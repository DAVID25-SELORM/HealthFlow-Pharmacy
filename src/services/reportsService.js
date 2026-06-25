import { isSupabaseConfigured } from '../lib/supabase'
import { getBranchReportBundle, shouldUseBranchServer } from './branchServerApi'
import { invokeTierAccess } from './tierAccessService'

const ALL_REPORT_ROLES = [
  'super_admin',
  'admin',
  'branch_manager',
]

const ROLE_REPORT_ACCESS = {
  super_admin: ['all'],
  admin: ['all'],
  branch_manager: ['all'],
  claims_officer: ['nhis'],
  pharmacist: ['nhis', 'inventory'],
  cashier: ['sales', 'accounting'],
  inventory_officer: ['inventory', 'purchases'],
  procurement: ['inventory', 'purchases'],
  accountant: ['accounting', 'sales'],
  accounts_officer: ['accounting', 'sales'],
  billing: ['nhis', 'accounting', 'patients'],
  records_officer: ['patients', 'nhis'],
}

const toArray = (value) => (Array.isArray(value) ? value : [])

const normalizeRole = (role) => String(role || '').toLowerCase()

const hasReportAccess = (role, category) => {
  const normalizedRole = normalizeRole(role)
  if (ALL_REPORT_ROLES.includes(normalizedRole)) {
    return true
  }

  const allowedCategories = ROLE_REPORT_ACCESS[normalizedRole] || []
  return allowedCategories.includes('all') || allowedCategories.includes(category)
}

export const REPORT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'analytics', label: 'Drug Utilization' },
  { id: 'sales', label: 'Sales' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'patients', label: 'Patients' },
  { id: 'nhis', label: 'NHIS Claims' },
  { id: 'accounting', label: 'Accounting' },
  { id: 'staff', label: 'Staff Activity' },
  { id: 'exports', label: 'Exports' },
]

export const REPORT_CATALOG = [
  {
    id: 'sales-summary',
    tab: 'sales',
    category: 'sales',
    title: 'Sales/POS Report',
    description: 'Daily sales, payment mix, item ledger, cashier totals, and refunds.',
  },
  {
    id: 'drug-utilization',
    tab: 'analytics',
    category: 'inventory',
    title: 'Drug Utilization Report',
    description: 'Patients served, prescriptions, quantities dispensed, revenue, and NHIS value by drug.',
  },
  {
    id: 'drug-patient-drilldown',
    tab: 'analytics',
    category: 'inventory',
    title: 'Patient-Level Drug Drill Down',
    description: 'Patient-by-patient dispensing detail for the selected drug and filters.',
  },
  {
    id: 'top-dispensed-drugs',
    tab: 'analytics',
    category: 'inventory',
    title: 'Top 10 Dispensed Drugs',
    description: 'Highest volume medicines with patient count, quantity, revenue, and NHIS value.',
  },
  {
    id: 'disease-drug-analysis',
    tab: 'analytics',
    category: 'nhis',
    title: 'Disease vs Drug Analysis',
    description: 'Diagnosis-linked medicine consumption for NHIS and hospital audit justification.',
  },
  {
    id: 'nhis-drug-consumption',
    tab: 'analytics',
    category: 'nhis',
    title: 'NHIS Drug Consumption Report',
    description: 'NHIS medicine quantities served and claim value by drug.',
  },
  {
    id: 'drug-movement',
    tab: 'analytics',
    category: 'inventory',
    title: 'Drug Movement Report',
    description: 'Opening estimate, purchases, dispensed quantities, expired stock, and current balance by drug.',
  },
  {
    id: 'drug-utilization-trends',
    tab: 'analytics',
    category: 'inventory',
    title: 'Drug Utilization Trends',
    description: 'Monthly, quarterly, and yearly utilization trend rows by drug.',
  },
  {
    id: 'inventory-stock',
    tab: 'inventory',
    category: 'inventory',
    title: 'Inventory Report',
    description: 'Current stock values, quantity on hand, categories, and branch stock position.',
  },
  {
    id: 'low-stock',
    tab: 'inventory',
    category: 'inventory',
    title: 'Low Stock Report',
    description: 'Items at or below reorder level for replenishment planning.',
  },
  {
    id: 'expired-expiring',
    tab: 'inventory',
    category: 'inventory',
    title: 'Expired/Expiring Drugs Report',
    description: 'Expired stock and medicines expiring within the next 30 days.',
  },
  {
    id: 'purchases',
    tab: 'purchases',
    category: 'purchases',
    title: 'Purchases Report',
    description: 'Purchase orders, supplier invoices, receiving status, and totals.',
  },
  {
    id: 'supplier-balances',
    tab: 'purchases',
    category: 'purchases',
    title: 'Supplier Balances Report',
    description: 'Supplier payables and outstanding purchase balances where supplier data is cached.',
  },
  {
    id: 'patients',
    tab: 'patients',
    category: 'patients',
    title: 'Patients Report',
    description: 'Patient registration, insurance identifiers, branches, and recent activity.',
  },
  {
    id: 'nhis-summary',
    tab: 'nhis',
    category: 'nhis',
    title: 'NHIS Claims Summary',
    description: 'Claim totals by status, claim value, submission readiness, and NHIA state.',
  },
  {
    id: 'submitted-claims',
    tab: 'nhis',
    category: 'nhis',
    title: 'Submitted Claims Report',
    description: 'Claims already submitted to NHIA or CLAIM-it.',
  },
  {
    id: 'pending-claims',
    tab: 'nhis',
    category: 'nhis',
    title: 'Pending Claims Report',
    description: 'Claims in draft, ready, pending, or failed retry state.',
  },
  {
    id: 'approved-claims',
    tab: 'nhis',
    category: 'nhis',
    title: 'Approved Claims Report',
    description: 'Accepted, approved, and paid NHIS claims.',
  },
  {
    id: 'rejected-claims',
    tab: 'nhis',
    category: 'nhis',
    title: 'Rejected Claims Report',
    description: 'Rejected or failed claims with error context where available.',
  },
  {
    id: 'unserved-medicines',
    tab: 'nhis',
    category: 'nhis',
    title: 'Unserved Medicines Report',
    description: 'Claims that include unserved medicine notes for NHIS follow-up.',
  },
  {
    id: 'nhis-medicines-dispensed',
    tab: 'nhis',
    category: 'nhis',
    title: 'NHIS Medicines Dispensed Report',
    description: 'NHIS medicine lines, quantities, tariffs, and claim linkage.',
  },
  {
    id: 'nhis-patient-return-alerts',
    tab: 'nhis',
    category: 'nhis',
    title: 'NHIS Patient Return Alerts',
    description: 'Patients who returned within 24 hours, with same or different medicines supplied.',
  },
  {
    id: 'tariff-gdrg-services',
    tab: 'nhis',
    category: 'nhis',
    title: 'Tariff/GDRG Services Report',
    description: 'Hospital mode service and GDRG lines attached to NHIS claims.',
  },
  {
    id: 'claims-officer-activity',
    tab: 'nhis',
    category: 'nhis',
    title: 'Claims Officer Activity Report',
    description: 'Claim generation, CC code, submission, export, and reconciliation activity by officer.',
  },
  {
    id: 'monthly-nhis-submission',
    tab: 'nhis',
    category: 'nhis',
    title: 'Monthly NHIS Submission Report',
    description: 'Monthly claim count, amount submitted, accepted, rejected, and pending.',
  },
  {
    id: 'nhia-reconciliation',
    tab: 'nhis',
    category: 'nhis',
    title: 'NHIA Reconciliation Report',
    description: 'Submitted, accepted, rejected, paid, and outstanding NHIA claim values.',
  },
  {
    id: 'claimit-export-history',
    tab: 'exports',
    category: 'nhis',
    title: 'Claim-it Export History Report',
    description: 'Generated batches, export format, file names, totals, and submission date.',
  },
  {
    id: 'cc-code-generation',
    tab: 'exports',
    category: 'nhis',
    title: 'CC Code Generation/Submission Report',
    description: 'CC/CCC generation attempts, direct submissions, status, and errors.',
  },
  {
    id: 'accounting-shifts',
    tab: 'accounting',
    category: 'accounting',
    title: 'Accounting/Cashier Shifts Report',
    description: 'Cashier shift movement, expected cash, and payment totals where cached.',
  },
  {
    id: 'insurance-receivables',
    tab: 'accounting',
    category: 'accounting',
    title: 'Insurance Receivables Report',
    description: 'Insurance and NHIS claim balances due from payers.',
  },
  {
    id: 'facility-billing',
    tab: 'accounting',
    category: 'accounting',
    title: 'Facility Subscription/Billing Report',
    description: 'Facility plan, subscription, and billing status where applicable.',
  },
  {
    id: 'staff-activity',
    tab: 'staff',
    category: 'staff',
    title: 'Staff Activity Report',
    description: 'Operational actions by user across claims, sales, inventory, and exports.',
  },
]

export const getVisibleReportCatalog = (role) =>
  REPORT_CATALOG.filter((report) => hasReportAccess(role, report.category))

export const canAccessReport = (role, reportId) => {
  const report = REPORT_CATALOG.find((item) => item.id === reportId)
  return Boolean(report && hasReportAccess(role, report.category))
}

export const getReportBundle = async (filters = {}) => {
  if (shouldUseBranchServer()) {
    return await getBranchReportBundle(filters)
  }

  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Use the local branch server or configure .env for cloud reports.')
  }

  return await invokeTierAccess({
    action: 'get_report_bundle',
    ...filters,
  })
}

export const normalizeReportBundle = (bundle = {}) => {
  const sales = toArray(bundle.sales)
  const claims = toArray(bundle.claims)
  const nhisClaims = toArray(bundle.nhisClaims || bundle.nhis_claims)
  const patients = toArray(bundle.patients)
  const drugs = toArray(bundle.drugs)
  const lowStock = toArray(bundle.lowStock)
  const expired = toArray(bundle.expired)
  const expiring = toArray(bundle.expiring)
  const purchases = toArray(bundle.purchases)
  const suppliers = toArray(bundle.suppliers)
  const exportHistory = toArray(bundle.exportHistory)
  const submissionLogs = toArray(bundle.submissionLogs)
  const staffActivity = toArray(bundle.staffActivity)

  return {
    ...bundle,
    sales,
    claims,
    nhisClaims,
    patients,
    drugs,
    lowStock,
    expired,
    expiring,
    purchases,
    suppliers,
    exportHistory,
    submissionLogs,
    staffActivity,
    metrics: {
      salesCount: sales.length,
      salesAmount: sales.reduce((sum, sale) => sum + Number(sale.net_amount ?? sale.netAmount ?? 0), 0),
      patientCount: patients.length,
      inventoryCount: drugs.length,
      purchasesCount: purchases.length,
      purchaseAmount: purchases.reduce((sum, purchase) => sum + Number(purchase.total_amount ?? purchase.totalAmount ?? 0), 0),
      claimsCount: claims.length,
      nhisClaimsCount: nhisClaims.length,
      pendingNhisClaims: nhisClaims.filter((claim) => ['draft', 'ready', 'pending', 'failed'].includes(String(claim.status || claim.claim_status || '').toLowerCase())).length,
      submittedNhisClaims: nhisClaims.filter((claim) => ['submitted', 'accepted', 'approved', 'paid', 'rejected'].includes(String(claim.status || claim.claim_status || '').toLowerCase())).length,
      approvedNhisClaims: nhisClaims.filter((claim) => ['accepted', 'approved', 'paid'].includes(String(claim.status || claim.claim_status || '').toLowerCase())).length,
      rejectedNhisClaims: nhisClaims.filter((claim) => ['rejected', 'failed'].includes(String(claim.status || claim.claim_status || '').toLowerCase())).length,
      lowStockCount: lowStock.length,
      expiredCount: expired.length,
      expiringCount: expiring.length,
      soldLineItems: sales.reduce((sum, sale) => sum + toArray(sale.sale_items || sale.items).length, 0),
      unitsSold: sales.reduce(
        (sum, sale) =>
          sum + toArray(sale.sale_items || sale.items).reduce((lineSum, item) => lineSum + Number(item.quantity || 0), 0),
        0
      ),
      dailySales: bundle.metrics?.dailySales || {},
      ...(bundle.metrics || {}),
    },
  }
}

export const buildReportHeaderRows = ({ title, filters, branding, generatedBy, branchName }) => [
  [branding.facilityName || 'HealthFlow Facility'],
  [title],
  [`Period: ${filters.startDate || 'All'} to ${filters.endDate || 'All'}`],
  [`NHIS Code: ${branding.nhisCode || 'Not set'}`],
  [`Address: ${branding.address || 'Not set'}`],
  [`Phone: ${branding.phone || 'Not set'}`],
  [`Branch: ${branchName || filters.branch || 'All branches'}`],
  [`Generated by: ${generatedBy || 'HealthFlow user'}`],
  [`Generated at: ${new Date().toLocaleString()}`],
  [],
]

export const downloadCsv = (filename, headers, rows, metadataRows = []) => {
  const csv = [...metadataRows, headers, ...rows]
    .map((row) =>
      row
        .map((cell) => {
          const value = cell ?? ''
          const escaped = String(value).replace(/"/g, '""')
          return `"${escaped}"`
        })
        .join(',')
    )
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.setAttribute('download', filename)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export const exportReportPdf = async ({ title, headers, rows, metadataRows = [] }) => {
  const { default: jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const margin = 36
  let y = margin

  doc.setFontSize(14)
  doc.text(title, margin, y)
  y += 20
  doc.setFontSize(9)

  metadataRows.flat().filter(Boolean).forEach((line) => {
    doc.text(String(line), margin, y)
    y += 13
  })
  y += 6

  const columns = headers.length || 1
  const pageWidth = doc.internal.pageSize.getWidth() - margin * 2
  const colWidth = pageWidth / columns

  doc.setFont(undefined, 'bold')
  headers.forEach((header, index) => {
    doc.text(String(header).slice(0, 24), margin + index * colWidth, y)
  })
  doc.setFont(undefined, 'normal')
  y += 14

  rows.forEach((row) => {
    if (y > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage()
      y = margin
    }
    row.forEach((cell, index) => {
      doc.text(String(cell ?? '').slice(0, 28), margin + index * colWidth, y)
    })
    y += 13
  })

  doc.save(`${title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'report'}.pdf`)
}

export const printReport = ({ title, headers, rows, metadataRows = [] }) => {
  const printWindow = window.open('', '_blank', 'noopener,noreferrer')
  if (!printWindow) {
    throw new Error('Unable to open print preview. Allow pop-ups and try again.')
  }

  const escapeHtml = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 24px; color: #1f2937; }
          h1 { font-size: 20px; margin: 0 0 12px; }
          p { margin: 3px 0; font-size: 12px; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 11px; }
          th, td { border: 1px solid #d1d5db; padding: 6px; text-align: left; vertical-align: top; }
          th { background: #f3f4f6; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(title)}</h1>
        ${metadataRows.flat().filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
        <table>
          <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
          <tbody>
            ${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </body>
    </html>
  `)
  printWindow.document.close()
  printWindow.focus()
  printWindow.print()
}
