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

const toLocalDayKey = (value) => {
  const date = startOfDay(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

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
    const key = toLocalDayKey(sale.sale_date)
    accumulator[key] = (accumulator[key] || 0) + Number.parseFloat(sale.net_amount || 0)
    return accumulator
  }, {})

  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(startOfDay(anchorDate), index - 6)
    return {
      label: shortDayFormatter.format(date),
      title: shortDateFormatter.format(date),
      amount: totalsByDay[toLocalDayKey(date)] || 0,
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
      title: `${shortDateFormatter.format(weekStart)} - ${shortDateFormatter.format(
        addDays(weekStart, 6)
      )}`,
      amount: sumNetAmount(filterSalesBetween(sales, weekStart, weekEnd)),
    }
  })
}

const createEmptyStats = (anchorDate = new Date()) => ({
  todaysSales: 0,
  todaysSalesTrend: 'No change vs yesterday',
  todaysSalesTrendTone: 'neutral',
  lowStock: 0,
  expiring: 0,
  monthlySales: 0,
  monthlySalesTrend: 'No change vs last month',
  monthlySalesTrendTone: 'neutral',
  dailyChart: buildDailyChart([], anchorDate),
  weeklyChart: buildWeeklyChart([], anchorDate),
})

const Dashboard = () => {
  const navigate = useNavigate()
  const { role } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [chartMode, setChartMode] = useState('daily')
  const [stats, setStats] = useState(() => createEmptyStats())
  const [recentSales, setRecentSales] = useState([])
  const [recentClaims, setRecentClaims] = useState([])

  const canViewOperationalMetrics = ['admin', 'pharmacist'].includes(role)

  useEffect(() => {
    void loadDashboardData()
  }, [role])

  const loadDashboardData = async () => {
    const today = new Date()

    try {
      setLoading(true)
      setError('')

      if (!isSupabaseConfigured()) {
        setStats(createEmptyStats(today))
        setRecentSales([])
        setRecentClaims([])
        setError('Supabase is not configured. Update .env to enable dashboard analytics.')
        return
      }

      const previousMonthStart = startOfMonth(
        new Date(today.getFullYear(), today.getMonth() - 1, 1)
      )
      const results = await Promise.allSettled([
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

      const failures = []
      const collectValue = (result, label, fallbackValue) => {
        if (result.status === 'fulfilled') {
          return result.value
        }

        console.error(`Unable to load dashboard ${label}:`, result.reason)
        failures.push(label)
        return fallbackValue
      }

      const salesHistory = collectValue(results[0], 'sales history', [])
      const sales = collectValue(results[1], 'recent sales', [])
      const lowStock = collectValue(results[2], 'low stock alerts', [])
      const expiring = collectValue(results[3], 'expiring alerts', [])
      const claims = collectValue(results[4], 'recent claims', [])

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

      if (failures.length > 0) {
        setError('Some dashboard data could not be loaded. Showing available live records only.')
      }
    } catch (loadError) {
      console.error('Error loading dashboard:', loadError)
      setStats(createEmptyStats(today))
      setRecentSales([])
      setRecentClaims([])
      setError('Unable to load dashboard data right now.')
    } finally {
      setLoading(false)
    }
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

      {error && <div className="dashboard-alert">{error}</div>}

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
