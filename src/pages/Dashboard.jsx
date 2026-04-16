import { useEffect, useMemo, useState } from 'react'
import { DollarSign, AlertTriangle, Clock, TrendingUp } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { getAllSales, getRecentSales } from '../services/salesService'
import { getLowStockDrugs, getExpiringDrugs } from '../services/drugService'
import { getRecentClaims } from '../services/claimsService'
import { isSupabaseConfigured } from '../lib/supabase'
import './Dashboard.css'

const currencyFormatter = new Intl.NumberFormat('en-GH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const shortDayFormatter = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
const shortDateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

const startOfDay = (value) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

const endOfDay = (value) => {
  const date = new Date(value)
  date.setHours(23, 59, 59, 999)
  return date
}

const startOfMonth = (value) => {
  const date = startOfDay(value)
  date.setDate(1)
  return date
}

const addDays = (value, amount) => {
  const date = new Date(value)
  date.setDate(date.getDate() + amount)
  return date
}

const getWeekStart = (value) => {
  const date = startOfDay(value)
  const diff = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - diff)
  return date
}

const toDayKey = (value) => startOfDay(value).toISOString().split('T')[0]

const sumNetAmount = (sales) =>
  sales.reduce((sum, sale) => sum + Number.parseFloat(sale.net_amount || 0), 0)

const filterSalesBetween = (sales, start, end) =>
  sales.filter((sale) => {
    const saleDate = new Date(sale.sale_date)
    return saleDate >= start && saleDate <= end
  })

const buildTrend = (current, previous, comparisonLabel) => {
  if (previous === 0) {
    if (current === 0) {
      return {
        label: `No change vs ${comparisonLabel}`,
        tone: 'neutral',
      }
    }

    return {
      label: `New activity vs ${comparisonLabel}`,
      tone: 'positive',
    }
  }

  const change = ((current - previous) / previous) * 100
  if (Math.abs(change) < 1) {
    return {
      label: `No change vs ${comparisonLabel}`,
      tone: 'neutral',
    }
  }

  return {
    label: `${change > 0 ? '+' : '-'}${Math.round(Math.abs(change))}% vs ${comparisonLabel}`,
    tone: change > 0 ? 'positive' : 'negative',
  }
}

const buildDailyChart = (sales, anchorDate) => {
  const totalsByDay = sales.reduce((accumulator, sale) => {
    const key = toDayKey(sale.sale_date)
    accumulator[key] = (accumulator[key] || 0) + Number.parseFloat(sale.net_amount || 0)
    return accumulator
  }, {})

  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(startOfDay(anchorDate), index - 6)
    return {
      label: shortDayFormatter.format(date),
      title: shortDateFormatter.format(date),
      amount: totalsByDay[toDayKey(date)] || 0,
    }
  })
}

const buildWeeklyChart = (sales, anchorDate) => {
  const currentWeekStart = getWeekStart(anchorDate)

  return Array.from({ length: 4 }, (_, index) => {
    const weekStart = addDays(currentWeekStart, (index - 3) * 7)
    const weekEnd = endOfDay(addDays(weekStart, 6))

    return {
      label: shortDateFormatter.format(weekStart),
      title: `${shortDateFormatter.format(weekStart)} - ${shortDateFormatter.format(addDays(weekStart, 6))}`,
      amount: sumNetAmount(filterSalesBetween(sales, weekStart, weekEnd)),
    }
  })
}

const Dashboard = () => {
  const navigate = useNavigate()
  const { role } = useAuth()
  const [loading, setLoading] = useState(true)
  const [chartMode, setChartMode] = useState('daily')
  const [stats, setStats] = useState({
    todaysSales: 0,
    todaysSalesTrend: 'No change vs yesterday',
    todaysSalesTrendTone: 'neutral',
    lowStock: 0,
    expiring: 0,
    monthlySales: 0,
    monthlySalesTrend: 'No change vs last month',
    monthlySalesTrendTone: 'neutral',
    dailyChart: [],
    weeklyChart: [],
  })
  const [recentSales, setRecentSales] = useState([])
  const [recentClaims, setRecentClaims] = useState([])

  const canViewOperationalMetrics = ['admin', 'pharmacist'].includes(role)

  useEffect(() => {
    void loadDashboardData()
  }, [role])

  const loadDashboardData = async () => {
    try {
      setLoading(true)

      if (!isSupabaseConfigured()) {
        console.warn('Supabase not configured, using sample data')
        setSampleData()
        return
      }

      const today = new Date()
      const previousMonthStart = startOfMonth(
        new Date(today.getFullYear(), today.getMonth() - 1, 1)
      )
      const [salesHistory, sales, lowStock, expiring, claims] = await Promise.all([
        getAllSales({
          startDate: previousMonthStart.toISOString(),
          endDate: today.toISOString(),
          paymentStatus: 'completed',
        }),
        getRecentSales(5),
        canViewOperationalMetrics ? getLowStockDrugs() : Promise.resolve([]),
        canViewOperationalMetrics ? getExpiringDrugs() : Promise.resolve([]),
        canViewOperationalMetrics ? getRecentClaims(5) : Promise.resolve([]),
      ])

      const yesterday = addDays(today, -1)
      const currentMonthStart = startOfMonth(today)
      const previousMonthEnd = endOfDay(addDays(currentMonthStart, -1))

      const todaysTotal = sumNetAmount(
        filterSalesBetween(salesHistory, startOfDay(today), endOfDay(today))
      )
      const yesterdayTotal = sumNetAmount(
        filterSalesBetween(salesHistory, startOfDay(yesterday), endOfDay(yesterday))
      )
      const monthlyTotal = sumNetAmount(
        filterSalesBetween(salesHistory, currentMonthStart, endOfDay(today))
      )
      const previousMonthTotal = sumNetAmount(
        filterSalesBetween(salesHistory, previousMonthStart, previousMonthEnd)
      )
      const todaysTrend = buildTrend(todaysTotal, yesterdayTotal, 'yesterday')
      const monthlyTrend = buildTrend(monthlyTotal, previousMonthTotal, 'last month')

      setStats({
        todaysSales: todaysTotal,
        todaysSalesTrend: todaysTrend.label,
        todaysSalesTrendTone: todaysTrend.tone,
        lowStock: lowStock.length,
        expiring: expiring.length,
        monthlySales: monthlyTotal,
        monthlySalesTrend: monthlyTrend.label,
        monthlySalesTrendTone: monthlyTrend.tone,
        dailyChart: buildDailyChart(salesHistory, today),
        weeklyChart: buildWeeklyChart(salesHistory, today),
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
      todaysSalesTrend: '+12% vs yesterday',
      todaysSalesTrendTone: 'positive',
      lowStock: 5,
      expiring: 3,
      monthlySales: 45230,
      monthlySalesTrend: '+8% vs last month',
      monthlySalesTrendTone: 'positive',
      dailyChart: [
        { label: 'Mon', title: 'Mon', amount: 650 },
        { label: 'Tue', title: 'Tue', amount: 750 },
        { label: 'Wed', title: 'Wed', amount: 850 },
        { label: 'Thu', title: 'Thu', amount: 600 },
        { label: 'Fri', title: 'Fri', amount: 800 },
        { label: 'Sat', title: 'Sat', amount: 550 },
        { label: 'Sun', title: 'Sun', amount: 700 },
      ],
      weeklyChart: [
        { label: 'Mar 24', title: 'Week of Mar 24', amount: 5800 },
        { label: 'Mar 31', title: 'Week of Mar 31', amount: 7200 },
        { label: 'Apr 7', title: 'Week of Apr 7', amount: 8100 },
        { label: 'Apr 14', title: 'Week of Apr 14', amount: 6700 },
      ],
    })
    setRecentSales([
      { id: '1', patients: { full_name: 'Kwame Boateng' }, net_amount: 250 },
      { id: '2', patients: { full_name: 'Ama Mensah' }, net_amount: 120 },
      { id: '3', patients: null, net_amount: 80 },
    ])
    setRecentClaims([
      { id: '1', patient_name: 'Adjoa K.', claim_status: 'approved', total_amount: 400 },
      { id: '2', patient_name: 'Kojo O.', claim_status: 'pending', total_amount: 220 },
      { id: '3', patient_name: 'Yaw S.', claim_status: 'rejected', total_amount: 150 },
    ])
    setLoading(false)
  }

  const statsCards = useMemo(() => {
    const cards = [
      {
        title: "Today's Sales",
        value: `GHS ${currencyFormatter.format(stats.todaysSales)}`,
        icon: DollarSign,
        color: 'primary',
        trend: stats.todaysSalesTrend,
        trendTone: stats.todaysSalesTrendTone,
      },
    ]

    if (canViewOperationalMetrics) {
      cards.push(
        {
          title: 'Low Stock Alerts',
          value: `${stats.lowStock} Items`,
          icon: AlertTriangle,
          color: 'warning',
          subtitle: 'Below reorder level',
        },
        {
          title: 'Expiring Soon',
          value: `${stats.expiring} Items`,
          icon: Clock,
          color: 'info',
          subtitle: '+30 Days',
        }
      )
    }

    cards.push({
      title: 'Monthly Sales',
      value: `GHS ${currencyFormatter.format(stats.monthlySales)}`,
      icon: TrendingUp,
      color: 'success',
      trend: stats.monthlySalesTrend,
      trendTone: stats.monthlySalesTrendTone,
    })

    return cards
  }, [canViewOperationalMetrics, stats])

  const chartData = useMemo(() => {
    const source = chartMode === 'weekly' ? stats.weeklyChart : stats.dailyChart
    const maxAmount = Math.max(...source.map((item) => item.amount), 0)

    return source.map((item) => ({
      ...item,
      height:
        maxAmount > 0
          ? Math.max((item.amount / maxAmount) * 100, item.amount > 0 ? 12 : 4)
          : 4,
      amountLabel: `GHS ${currencyFormatter.format(item.amount)}`,
    }))
  }, [chartMode, stats.dailyChart, stats.weeklyChart])

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
              {stat.trend && (
                <span className={`stat-trend ${stat.trendTone || 'neutral'}`}>{stat.trend}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="chart-section">
        <div className="section-header">
          <h2>Sales Overview</h2>
          <div className="chart-tabs">
            <button
              type="button"
              className={`tab-btn ${chartMode === 'daily' ? 'active' : ''}`}
              onClick={() => setChartMode('daily')}
            >
              Daily
            </button>
            <button
              type="button"
              className={`tab-btn ${chartMode === 'weekly' ? 'active' : ''}`}
              onClick={() => setChartMode('weekly')}
            >
              Weekly
            </button>
          </div>
        </div>
        <div className="chart-container">
          <div className="bar-chart">
            {chartData.map((item, index) => (
              <div key={index} className="bar-wrapper">
                <div
                  className="bar"
                  style={{ height: `${item.height}%` }}
                  title={`${item.title}: ${item.amountLabel}`}
                />
                <span className="bar-value">{item.amountLabel}</span>
                <span className="bar-label">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="activity-grid">
        <div className="activity-card">
          <div className="card-header">
            <h3>Recent Sales</h3>
            <button className="view-all-btn" type="button" onClick={() => navigate('/sales')}>
              View All
            </button>
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
                    <p className="activity-title">{sale.patients?.full_name || 'Walk-in Customer'}</p>
                  </div>
                  <span className="activity-amount">GHS {sale.net_amount}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {canViewOperationalMetrics && (
          <div className="activity-card">
            <div className="card-header">
              <h3>Recent Insurance Claims</h3>
              <button
                className="view-all-btn"
                type="button"
                onClick={() => navigate('/claims?tab=pending')}
              >
                View All
              </button>
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
        )}
      </div>
    </div>
  )
}

export default Dashboard
