import { FileText, Download, Calendar } from 'lucide-react'
import './Reports.css'

const Reports = () => {
  const reports = [
    {
      title: 'Daily Sales Report',
      description: 'View today\'s sales performance and transactions',
      icon: FileText,
      color: 'primary'
    },
    {
      title: 'Monthly Sales Report',
      description: 'Comprehensive monthly sales analysis and trends',
      icon: FileText,
      color: 'success'
    },
    {
      title: 'Claims Report',
      description: 'Insurance claims status and reimbursement tracking',
      icon: FileText,
      color: 'info'
    },
    {
      title: 'Expired Drugs Report',
      description: 'List of expired and expiring medications',
      icon: FileText,
      color: 'warning'
    },
    {
      title: 'Low Stock Report',
      description: 'Drugs below minimum stock levels',
      icon: FileText,
      color: 'danger'
    },
    {
      title: 'Patient History Report',
      description: 'Patient visit frequency and prescription patterns',
      icon: FileText,
      color: 'secondary'
    }
  ]

  return (
    <div className="reports-page">
      <div className="page-header">
        <div>
          <h1>Reports & Analytics</h1>
          <p>Generate and export various pharmacy reports</p>
        </div>
        <div className="date-range">
          <Calendar size={18} />
          <input type="date" defaultValue="2026-04-01" />
          <span>to</span>
          <input type="date" defaultValue="2026-04-04" />
        </div>
      </div>

      <div className="reports-grid">
        {reports.map((report, index) => (
          <div key={index} className={`report-card ${report.color}`}>
            <div className="report-icon">
              <report.icon size={32} />
            </div>
            <div className="report-content">
              <h3>{report.title}</h3>
              <p>{report.description}</p>
            </div>
            <div className="report-actions">
              <button className="btn btn-primary">
                Generate Report
              </button>
              <button className="btn btn-outline">
                <Download size={16} />
                Export PDF
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Reports
