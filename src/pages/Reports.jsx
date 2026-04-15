import { useMemo, useState } from 'react'
import { FileText, Download, Calendar, RefreshCcw } from 'lucide-react'
import { isSupabaseConfigured } from '../lib/supabase'
import { downloadCsv, getReportBundle } from '../services/reportsService'
import './Reports.css'

const today = new Date().toISOString().split('T')[0]
const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  .toISOString()
  .split('T')[0]

const Reports = () => {
  const [startDate, setStartDate] = useState(firstOfMonth)
  const [endDate, setEndDate] = useState(today)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [bundle, setBundle] = useState(null)

  const cards = useMemo(() => {
    if (!bundle) {
      return []
    }

    return [
      {
        key: 'daily-sales',
        title: 'Sales Summary',
        description: `Transactions: ${bundle.metrics.salesCount} | Revenue: GHS ${bundle.metrics.salesAmount.toFixed(2)}`,
        color: 'primary',
      },
      {
        key: 'claims',
        title: 'Claims Summary',
        description: `Total: ${bundle.metrics.claimsCount}, Approved: ${bundle.metrics.approvedClaims}, Rejected: ${bundle.metrics.rejectedClaims}`,
        color: 'info',
      },
      {
        key: 'stock',
        title: 'Stock Alerts',
        description: `Low: ${bundle.metrics.lowStockCount}, Expired: ${bundle.metrics.expiredCount}, Expiring soon: ${bundle.metrics.expiringCount}`,
        color: 'warning',
      },
      {
        key: 'patients',
        title: 'Patient and Inventory Footprint',
        description: `Patients: ${bundle.metrics.patientCount}, Active drugs: ${bundle.metrics.inventoryCount}`,
        color: 'secondary',
      },
    ]
  }, [bundle])

  const generateReports = async () => {
    try {
      setLoading(true)
      setError('')

      if (!isSupabaseConfigured()) {
        setError('Supabase is not configured. Update .env to enable reports.')
        return
      }

      if (startDate > endDate) {
        setError('Start date must be before or equal to end date.')
        return
      }

      const data = await getReportBundle(startDate, endDate)
      setBundle(data)
    } catch (reportError) {
      console.error('Error generating reports:', reportError)
      setError(reportError.message || 'Unable to generate reports.')
    } finally {
      setLoading(false)
    }
  }

  const exportSalesCsv = () => {
    if (!bundle) {
      return
    }

    const rows = bundle.sales.map((sale) => [
      sale.sale_number,
      sale.sale_date,
      sale.payment_method,
      sale.payment_status,
      sale.net_amount,
      sale.total_amount,
    ])

    downloadCsv('sales-report.csv', ['Sale Number', 'Sale Date', 'Payment Method', 'Status', 'Net Amount', 'Total Amount'], rows)
  }

  const exportClaimsCsv = () => {
    if (!bundle) {
      return
    }

    const rows = bundle.claims.map((claim) => [
      claim.claim_number,
      claim.patient_name,
      claim.insurance_provider,
      claim.claim_status,
      claim.total_amount,
      claim.service_date,
    ])

    downloadCsv('claims-report.csv', ['Claim Number', 'Patient', 'Insurance Provider', 'Status', 'Total Amount', 'Service Date'], rows)
  }

  return (
    <div className="reports-page">
      <div className="page-header">
        <div>
          <h1>Reports and Analytics</h1>
          <p>Generate operational reports for sales, stock, claims, and patient trends</p>
        </div>
        <div className="date-range">
          <Calendar size={18} />
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <span>to</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <button className="btn btn-primary" onClick={generateReports} disabled={loading}>
            <RefreshCcw size={16} />
            {loading ? 'Generating...' : 'Generate'}
          </button>
        </div>
      </div>

      {error && <div className="reports-alert">{error}</div>}

      <div className="reports-grid">
        {cards.map((report) => (
          <div key={report.key} className={`report-card ${report.color}`}>
            <div className="report-icon">
              <FileText size={32} />
            </div>
            <div className="report-content">
              <h3>{report.title}</h3>
              <p>{report.description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="reports-export">
        <button className="btn btn-primary" onClick={exportSalesCsv} disabled={!bundle}>
          <Download size={16} />
          Export Sales CSV
        </button>
        <button className="btn btn-outline" onClick={exportClaimsCsv} disabled={!bundle}>
          <Download size={16} />
          Export Claims CSV
        </button>
      </div>

      {bundle && (
        <div className="report-table-card">
          <h3>Daily Sales Breakdown</h3>
          <table className="report-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Revenue (GHS)</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(bundle.metrics.dailySales)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([date, value]) => (
                  <tr key={date}>
                    <td>{date}</td>
                    <td>{Number.parseFloat(value).toFixed(2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default Reports
