import { getAllSales } from './salesService'
import { getAllClaims } from './claimsService'
import { getAllPatients } from './patientService'
import { getAllDrugs, getExpiredDrugs, getExpiringDrugs, getLowStockDrugs } from './drugService'

const toDateOnly = (value) => new Date(value).toISOString().split('T')[0]

export const getReportBundle = async (startDate, endDate) => {
  const filters = {
    startDate: `${startDate}T00:00:00`,
    endDate: `${endDate}T23:59:59`,
  }

  const [sales, claims, lowStock, expired, expiring, patients, drugs] = await Promise.all([
    getAllSales(filters),
    getAllClaims({ startDate, endDate }),
    getLowStockDrugs(),
    getExpiredDrugs(),
    getExpiringDrugs(),
    getAllPatients(),
    getAllDrugs(),
  ])

  const dailySales = sales.reduce((acc, sale) => {
    const key = toDateOnly(sale.sale_date)
    acc[key] = (acc[key] || 0) + Number.parseFloat(sale.net_amount || 0)
    return acc
  }, {})

  return {
    sales,
    claims,
    lowStock,
    expired,
    expiring,
    patients,
    drugs,
    metrics: {
      salesCount: sales.length,
      salesAmount: sales.reduce((sum, sale) => sum + Number.parseFloat(sale.net_amount || 0), 0),
      soldLineItems: sales.reduce((sum, sale) => sum + (sale.sale_items?.length || 0), 0),
      unitsSold: sales.reduce(
        (sum, sale) =>
          sum +
          (sale.sale_items || []).reduce(
            (itemSum, item) => itemSum + Number.parseFloat(item.quantity || 0),
            0
          ),
        0
      ),
      claimsCount: claims.length,
      approvedClaims: claims.filter((claim) => claim.claim_status === 'approved').length,
      rejectedClaims: claims.filter((claim) => claim.claim_status === 'rejected').length,
      lowStockCount: lowStock.length,
      expiredCount: expired.length,
      expiringCount: expiring.length,
      patientCount: patients.length,
      inventoryCount: drugs.length,
      dailySales,
    },
  }
}

export const downloadCsv = (filename, headers, rows) => {
  const csv = [headers, ...rows]
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
