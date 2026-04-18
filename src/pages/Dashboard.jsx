import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  ClipboardList,
  Clock,
  DollarSign,
  Package,
  Settings,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { getAllSales, getRecentSales } from '../services/salesService'
import { getLowStockDrugs, getExpiringDrugs } from '../services/drugService'
import { getRecentClaims } from '../services/claimsService'
import { useTenant } from '../context/TenantContext'
import { isSupabaseConfigured } from '../lib/supabase'
import './Dashboard.css'

const currencyFormatter = new Intl.NumberFormat('en-GH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const fullDateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
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

const formatRoleLabel = (value) =>
  String(value || 'assistant')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())

const resolveWelcomeName = (value) => {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.includes('@')) {
    return 'there'
  }

  return normalized.split(/\s+/)[0]
}

const formatTrialLabel = (daysUntilTrialExpires) => {
  if (!Number.isFinite(daysUntilTrialExpires)) {
    return 'Trial active'
  }

  return `${daysUntilTrialExpires} day${daysUntilTrialExpires === 1 ? '' : 's'} left in trial`
}

const formatCountLabel = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`

const formatActivityTimestamp = (value) => {
  if (!value) {
    return 'Recently updated'
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
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
  const { role, displayName } = useAuth()
  const { tierLimits, organization, isTrialActive, daysUntilTrialExpires, isSuspended } = useTenant()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [chartMode, setChartMode] = useState('daily')
  const [stats, setStats] = useState(() => createEmptyStats())
  const [recentSales, setRecentSales] = useState([])
  const [recentClaims, setRecentClaims] = useState([])

  const canViewOperationalMetrics = ['admin', 'pharmacist'].includes(role)
  const canViewClaimsMetrics = canViewOperationalMetrics && tierLimits.hasClaims
  const pharmacyName = organization?.name || 'Your Pharmacy'
  const welcomeName = resolveWelcomeName(displayName)
  const roleLabel = formatRoleLabel(role)
  const planLabel = tierLimits?.label || 'Basic'
  const subscriptionSummary = isSuspended
    ? 'Access is currently paused. Re-enable the subscription to resume full daily operations.'
    : isTrialActive
      ? `${pharmacyName} is in a guided trial period so you can set up stock, patients, and workflow before go-live.`
      : `${pharmacyName} is ready for day-to-day pharmacy operations on the ${planLabel} plan.`

  useEffect(() => {
    void loadDashboardData()
  }, [role, tierLimits.hasClaims])

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
        canViewClaimsMetrics ? getRecentClaims(5) : Promise.resolve([]),
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

  const hasChartActivity = useMemo(
    () => chartData.some((item) => item.amount > 0),
    [chartData]
  )

  const quickActions = useMemo(() => {
    const actions = [
      {
        label: 'Start Sale',
        description: 'Open POS and record the next checkout.',
        icon: ShoppingCart,
        path: '/sales',
        tone: 'primary',
      },
      {
        label: 'Add Patient',
        description: 'Register a new patient or walk-in profile.',
        icon: Users,
        path: '/patients',
        tone: 'secondary',
      },
    ]

    if (canViewOperationalMetrics) {
      actions.push({
        label: 'Update Stock',
        description: 'Set quantities, pricing, and expiry dates.',
        icon: Package,
        path: '/inventory',
        tone: 'secondary',
      })
    }

    if (canViewClaimsMetrics) {
      actions.push({
        label: 'Review Claims',
        description: 'Check the latest insurance submissions.',
        icon: ClipboardList,
        path: '/claims?tab=pending',
        tone: 'secondary',
      })
    } else if (tierLimits.hasReports && canViewOperationalMetrics) {
      actions.push({
        label: 'Open Reports',
        description: 'See revenue and inventory performance.',
        icon: BarChart3,
        path: '/reports',
        tone: 'secondary',
      })
    } else if (role === 'admin') {
      actions.push({
        label: 'Pharmacy Settings',
        description: 'Update pharmacy profile and staff access.',
        icon: Settings,
        path: '/settings',
        tone: 'secondary',
      })
    }

    return actions
  }, [canViewClaimsMetrics, canViewOperationalMetrics, role, tierLimits.hasReports])

  const focusItems = useMemo(() => {
    if (canViewOperationalMetrics) {
      return [
        {
          label: 'Low stock',
          value: formatCountLabel(stats.lowStock, 'item'),
          hint: stats.lowStock > 0 ? 'Needs reorder attention' : 'Shelves look healthy',
        },
        {
          label: 'Expiring soon',
          value: formatCountLabel(stats.expiring, 'item'),
          hint: 'Within the next 30 days',
        },
        {
          label: 'Month to date',
          value: `GHS ${currencyFormatter.format(stats.monthlySales)}`,
          hint: stats.monthlySalesTrend,
        },
      ]
    }

    return [
      {
        label: "Today's sales",
        value: `GHS ${currencyFormatter.format(stats.todaysSales)}`,
        hint: stats.todaysSalesTrend,
      },
      {
        label: 'Month to date',
        value: `GHS ${currencyFormatter.format(stats.monthlySales)}`,
        hint: stats.monthlySalesTrend,
      },
      {
        label: 'Recent checkouts',
        value: formatCountLabel(recentSales.length, 'sale'),
        hint: 'Latest completed transactions',
      },
    ]
  }, [
    canViewOperationalMetrics,
    recentSales.length,
    stats.expiring,
    stats.lowStock,
    stats.monthlySales,
    stats.monthlySalesTrend,
    stats.todaysSales,
    stats.todaysSalesTrend,
  ])

  const featurePills = useMemo(
    () => [
      { label: 'Reports', enabled: tierLimits.hasReports },
      { label: 'Claims', enabled: tierLimits.hasClaims },
      { label: 'Bulk Import', enabled: tierLimits.hasAdvancedInventory },
    ],
    [tierLimits.hasAdvancedInventory, tierLimits.hasClaims, tierLimits.hasReports]
  )

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
      <section className="dashboard-hero">
        <div className="hero-copy">
          <div className="hero-eyebrow">
            <Sparkles size={14} />
            Pharmacy command center
          </div>
          <h1>{`Welcome back, ${welcomeName}.`}</h1>
          <p className="hero-subtitle">{subscriptionSummary}</p>

          <div className="hero-meta">
            <span className="hero-chip hero-chip-strong">{pharmacyName}</span>
            <span className="hero-chip">{fullDateFormatter.format(new Date())}</span>
            <span className="hero-chip">{roleLabel}</span>
            <span className="hero-chip">{planLabel} Plan</span>
            {isTrialActive && <span className="hero-chip">{formatTrialLabel(daysUntilTrialExpires)}</span>}
            {isSuspended && <span className="hero-chip hero-chip-danger">Suspended</span>}
          </div>

          <div className="hero-actions">
            {quickActions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={`hero-action hero-action-${action.tone}`}
                onClick={() => navigate(action.path)}
              >
                <div className="hero-action-icon">
                  <action.icon size={18} />
                </div>
                <div className="hero-action-copy">
                  <span className="hero-action-label">{action.label}</span>
                  <span className="hero-action-description">{action.description}</span>
                </div>
                <ArrowRight size={16} className="hero-action-arrow" />
              </button>
            ))}
          </div>
        </div>

        <aside className="hero-panel">
          <div className="hero-panel-header">
            <span className="hero-panel-label">Today&apos;s focus</span>
            <span className="hero-panel-caption">What deserves attention first</span>
          </div>

          <div className="hero-panel-grid">
            {focusItems.map((item) => (
              <div key={item.label} className="hero-panel-card">
                <span className="hero-panel-card-label">{item.label}</span>
                <strong className="hero-panel-card-value">{item.value}</strong>
                <span className="hero-panel-card-hint">{item.hint}</span>
              </div>
            ))}
          </div>

          <div className="hero-feature-pills">
            {featurePills.map((feature) => (
              <span
                key={feature.label}
                className={`feature-pill ${feature.enabled ? 'enabled' : 'locked'}`}
              >
                {feature.label} {feature.enabled ? 'On' : 'Locked'}
              </span>
            ))}
          </div>
        </aside>
      </section>

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
          {hasChartActivity ? (
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
          ) : (
            <div className="chart-empty-state">
              <div className="chart-empty-icon">
                <TrendingUp size={22} />
              </div>
              <h3>No completed sales yet</h3>
              <p>
                Once this pharmacy starts recording checkouts, the {chartMode} trend will appear
                here automatically.
              </p>
              <button type="button" className="inline-action-btn" onClick={() => navigate('/sales')}>
                Open POS
              </button>
            </div>
          )}
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
              <div className="activity-empty-state">
                <div className="activity-empty-icon">
                  <ShoppingCart size={20} />
                </div>
                <p className="activity-empty-title">No sales yet</p>
                <p className="activity-empty-copy">
                  Start with a walk-in or registered patient sale to populate this feed.
                </p>
                <button
                  type="button"
                  className="inline-action-btn"
                  onClick={() => navigate('/sales')}
                >
                  Start Sale
                </button>
              </div>
            ) : (
              recentSales.map((sale) => (
                <div key={sale.id} className="activity-item">
                  <div className="activity-info">
                    <div>
                      <p className="activity-title">{sale.patients?.full_name || 'Walk-in Customer'}</p>
                      <p className="activity-meta">
                        {sale.sale_number || 'Completed sale'} • {formatActivityTimestamp(sale.sale_date)}
                      </p>
                    </div>
                  </div>
                  <span className="activity-amount">GHS {sale.net_amount}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {canViewClaimsMetrics && (
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
                <div className="activity-empty-state">
                  <div className="activity-empty-icon">
                    <ClipboardList size={20} />
                  </div>
                  <p className="activity-empty-title">No claims yet</p>
                  <p className="activity-empty-copy">
                    Claims will appear here once insurance-based prescriptions start moving through
                    the pharmacy.
                  </p>
                  <button
                    type="button"
                    className="inline-action-btn"
                    onClick={() => navigate('/claims')}
                  >
                    Open Claims
                  </button>
                </div>
              ) : (
                recentClaims.map((claim) => (
                  <div key={claim.id} className="activity-item">
                    <div className="activity-info">
                      <div>
                        <p className="activity-title">{claim.patient_name}</p>
                        <p className="activity-meta">
                          {claim.claim_number || 'Insurance claim'} •{' '}
                          {formatActivityTimestamp(claim.submitted_at || claim.service_date)}
                        </p>
                      </div>
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
