import { useState, useEffect } from 'react'
import { DollarSign, AlertTriangle, Clock, TrendingUp } from 'lucide-react'
import { getTodaysSales, getRecentSales } from '../services/salesService'
import { getLowStockDrugs, getExpiringDrugs } from '../services/drugService'
import { getRecentClaims } from '../services/claimsService'
import { isSupabaseConfigured } from '../lib/supabase'
import './Dashboard.css'

const Dashboard = () => {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({
    todaysSales: 0,
    lowStock: 0,
    expiring: 0,
    monthlySales: 0
  })
  const [recentSales, setRecentSales] = useState([])
  const [recentClaims, setRecentClaims] = useState([])
  
  useEffect(() => {
    loadDashboardData()
  }, [])
  
  const loadDashboardData = async () => {
    try {
      setLoading(true)
      
      if (!isSupabaseConfigured()) {
        console.warn('Supabase not configured, using sample data')
        setSampleData()
        return
      }
      
      // Load all dashboard data
      const [todaySales, lowStock, expiring, sales, claims] = await Promise.all([
        getTodaysSales(),
        getLowStockDrugs(),
        getExpiringDrugs(),
        getRecentSales(5),
        getRecentClaims(5)
      ])
      
      const todaysTotal = todaySales.reduce((sum, sale) => sum + parseFloat(sale.net_amount || 0), 0)
      
      setStats({
        todaysSales: todaysTotal,
        lowStock: lowStock.length,
        expiring: expiring.length,
        monthlySales: todaysTotal * 20 // Rough estimate
      })
      
      setRecentSales(sales)
      setRecentClaims(claims)
      
    } catch (error) {
      console.error('Error loading dashboard:', error)
      setSampleData()
    } finally {
      setLoading(false)
    }
  }
  
  const setSampleData = () => {
    setStats({
      todaysSales: 1850,
      lowStock: 5,
      expiring: 3,
      monthlySales: 45230
    })
    setRecentSales([
      { id: '1', patients: { full_name: 'Kwame Boateng' }, net_amount: 250 },
      { id: '2', patients: { full_name: 'Ama Mensah' }, net_amount: 120 },
      { id: '3', patients: null, net_amount: 80 }
    ])
    setRecentClaims([
      { id: '1', patient_name: 'Adjoa K.', claim_status: 'approved', total_amount: 400 },
      { id: '2', patient_name: 'Kojo O.', claim_status: 'pending', total_amount: 220 },
      { id: '3', patient_name: 'Yaw S.', claim_status: 'rejected', total_amount: 150 }
    ])
    setLoading(false)
  }
  
  // Config for stat cards
  const statsCards = [
    {
      title: "Today's Sales",
      value: `GHS ${stats.todaysSales.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      icon: DollarSign,
      color: 'primary',
      trend: '+12% from yesterday'
    },
    {
      title: "Low Stock Alerts",
      value: `${stats.lowStock} Items`,
      icon: AlertTriangle,
      color: 'warning',
      subtitle: 'Below reorder level'
    },
    {
      title: "Expiring Soon",
      value: `${stats.expiring} Items`,
      icon: Clock,
      color: 'info',
      subtitle: '+30 Days'
    },
    {
      title: "Monthly Sales",
      value: `GHS ${stats.monthlySales.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      icon: TrendingUp,
      color: 'success',
      trend: '+8% from last month'
    }
  ]

  const salesData = [
    { day: 'Mon', value: 65 },
    { day: 'Tue', value: 75 },
    { day: 'Wed', value: 85 },
    { day: 'Thu', value: 60 },
    { day: 'Fri', value: 80 },
    { day: 'Sat', value: 55 },
    { day: 'Sun', value: 70 }
  ]
  
  if (loading) {
    return (
      <div className="dashboard">
        <div className="page-header">
          <h1>Loading Dashboard...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="dashboard">
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Welcome back! Here's what's happening today.</p>
      </div>

      {/* Stats Cards */}
      <div className="stats-grid">
        {statsCards.map((stat, index) => (
          <div key={index} className={`stat-card ${stat.color}`}>
            <div className="stat-icon">
              <stat.icon size={24} />
            </div>
            <div className="stat-content">
              <h3>{stat.title}</h3>
              <p className="stat-value">{stat.value}</p>
              {stat.subtitle && <span className="stat-subtitle">{stat.subtitle}</span>}
              {stat.trend && <span className="stat-trend">{stat.trend}</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Sales Chart */}
      <div className="chart-section">
        <div className="section-header">
          <h2>Sales Overview</h2>
          <div className="chart-tabs">
            <button className="tab-btn active">Daily</button>
            <button className="tab-btn">Weekly</button>
          </div>
        </div>
        <div className="chart-container">
          <div className="bar-chart">
            {salesData.map((item, index) => (
              <div key={index} className="bar-wrapper">
                <div 
                  className="bar" 
                  style={{ height: `${item.value}%` }}
                  title={`${item.day}: ${item.value}%`}
                ></div>
                <span className="bar-label">{item.day}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="activity-grid">
        {/* Recent Sales */}
        <div className="activity-card">
          <div className="card-header">
            <h3>Recent Sales</h3>
            <button className="view-all-btn">View All →</button>
          </div>
          <div className="activity-list">
            {recentSales.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--gray-500)' }}>
                No sales yet
              </div>
            ) : (
              recentSales.map((sale) => (
                <div key={sale.id} className="activity-item">
                  <div className="activity-info">
                    <p className="activity-title">
                      {sale.patients?.full_name || 'Walk-in Customer'}
                    </p>
                  </div>
                  <span className="activity-amount">GHS {sale.net_amount}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Claims */}
        <div className="activity-card">
          <div className="card-header">
            <h3>Recent Insurance Claims</h3>
            <button className="view-all-btn">View All →</button>
          </div>
          <div className="activity-list">
            {recentClaims.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--gray-500)' }}>
                No claims yet
              </div>
            ) : (
              recentClaims.map((claim) => (
                <div key={claim.id} className="activity-item">
                  <div className="activity-info">
                    <p className="activity-title">{claim.patient_name}</p>
                    <span className={`status-badge status-${claim.claim_status}`}>
                      {claim.claim_status.charAt(0).toUpperCase() + claim.claim_status.slice(1)}
                    </span>
                  </div>
                  <span className="activity-amount">GHS {claim.total_amount}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
