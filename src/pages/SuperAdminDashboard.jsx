import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Clock3,
  GitBranch,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getTenantAdminDashboard } from '../services/tenantAdminService'
import './SuperAdminDashboard.css'

const STATUS_LABELS = {
  active: 'Active',
  trial: 'Trial',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
}

const PLATFORM_ALERT_WINDOW_DAYS = 14

const fullDateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const shortDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const normalizeDate = (value) => {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const countTotal = (values = {}) =>
  Object.values(values).reduce((sum, value) => sum + Number(value || 0), 0)

const getLifecycleDate = (organization) =>
  organization.status === 'trial'
    ? normalizeDate(organization.trial_ends_at)
    : normalizeDate(organization.subscription_ends_at)

const getDaysUntil = (value) => {
  const target = normalizeDate(value)
  if (!target) {
    return null
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const targetDay = new Date(target)
  targetDay.setHours(0, 0, 0, 0)

  return Math.ceil((targetDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

const formatLifecycleLabel = (organization, daysUntil) => {
  const lifecycleLabel = organization.status === 'trial' ? 'Trial' : 'Subscription'

  if (daysUntil === null) {
    return `${lifecycleLabel} date not set`
  }

  if (daysUntil < 0) {
    return `${lifecycleLabel} overdue by ${Math.abs(daysUntil)} day${Math.abs(daysUntil) === 1 ? '' : 's'}`
  }

  if (daysUntil === 0) {
    return `${lifecycleLabel} ends today`
  }

  return `${lifecycleLabel} ends in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`
}

const buildRenewalWatchlist = (organizations) =>
  organizations
    .map((organization) => {
      const lifecycleDate = getLifecycleDate(organization)
      const daysUntil = getDaysUntil(lifecycleDate)

      return {
        id: organization.id,
        name: organization.name,
        status: organization.status,
        subscriptionTier: organization.subscription_tier,
        lifecycleDate,
        daysUntil,
      }
    })
    .filter(
      (organization) =>
        organization.lifecycleDate &&
        organization.daysUntil !== null &&
        organization.daysUntil <= PLATFORM_ALERT_WINDOW_DAYS
    )
    .sort((left, right) => left.lifecycleDate.getTime() - right.lifecycleDate.getTime())

const buildSetupAlerts = (organizations, userCounts, branchCounts) =>
  organizations
    .flatMap((organization) => {
      const alerts = []

      if ((userCounts[organization.id] || 0) === 0) {
        alerts.push({
          id: `${organization.id}-users`,
          organizationName: organization.name,
          message: `${organization.name} has no staff users yet.`,
        })
      }

      if ((branchCounts[organization.id] || 0) === 0) {
        alerts.push({
          id: `${organization.id}-branches`,
          organizationName: organization.name,
          message: `${organization.name} needs its first branch.`,
        })
      }

      if (!organization.email || !organization.phone) {
        alerts.push({
          id: `${organization.id}-contact`,
          organizationName: organization.name,
          message: `${organization.name} is missing a contact email or phone number.`,
        })
      }

      return alerts
    })
    .slice(0, 8)

const buildRecentActivity = (organizations, userCounts, branchCounts) =>
  [...organizations]
    .sort(
      (left, right) =>
        new Date(right.updated_at || right.created_at).getTime() -
        new Date(left.updated_at || left.created_at).getTime()
    )
    .slice(0, 6)
    .map((organization) => ({
      id: organization.id,
      name: organization.name,
      status: organization.status,
      subscriptionTier: organization.subscription_tier,
      updatedAt: organization.updated_at || organization.created_at,
      userCount: userCounts[organization.id] || 0,
      branchCount: branchCounts[organization.id] || 0,
    }))

const SuperAdminDashboard = () => {
  const navigate = useNavigate()
  const [platformData, setPlatformData] = useState({
    organizations: [],
    userCounts: {},
    branchCounts: {},
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const loadPlatformDashboard = async () => {
      try {
        setLoading(true)
        setError('')
        const dashboard = await getTenantAdminDashboard()
        setPlatformData(dashboard)
      } catch (loadError) {
        console.error('Unable to load super admin dashboard:', loadError)
        setError(loadError.message || 'Unable to load platform dashboard right now.')
      } finally {
        setLoading(false)
      }
    }

    void loadPlatformDashboard()
  }, [])

  const { organizations, userCounts, branchCounts } = platformData
  const totalUsers = countTotal(userCounts)
  const totalBranches = countTotal(branchCounts)
  const renewalWatchlist = buildRenewalWatchlist(organizations)
  const setupAlerts = buildSetupAlerts(organizations, userCounts, branchCounts)
  const recentActivity = buildRecentActivity(organizations, userCounts, branchCounts)
  const statusCounts = organizations.reduce(
    (counts, organization) => ({
      ...counts,
      [organization.status]: (counts[organization.status] || 0) + 1,
    }),
    {
      active: 0,
      trial: 0,
      suspended: 0,
      cancelled: 0,
    }
  )

  const summaryCards = [
    {
      title: 'Total Pharmacies',
      value: organizations.length,
      subtitle: `${statusCounts.active} active tenants live on the platform`,
      icon: Building2,
      tone: 'primary',
    },
    {
      title: 'Platform Users',
      value: totalUsers,
      subtitle: 'All staff accounts across tenant organizations',
      icon: Users,
      tone: 'secondary',
    },
    {
      title: 'Branches',
      value: totalBranches,
      subtitle: 'Registered operating locations across all pharmacies',
      icon: GitBranch,
      tone: 'info',
    },
    {
      title: 'Attention Needed',
      value: renewalWatchlist.length + setupAlerts.length,
      subtitle: `${renewalWatchlist.length} renewal watch item${renewalWatchlist.length === 1 ? '' : 's'}`,
      icon: AlertTriangle,
      tone: 'warning',
    },
  ]

  if (loading) {
    return (
      <div className="super-admin-dashboard">
        <div className="page-header">
          <h1>Loading platform dashboard...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="super-admin-dashboard">
      <section className="platform-hero">
        <div className="platform-hero-copy">
          <div className="platform-eyebrow">
            <Sparkles size={14} />
            Super admin workspace
          </div>
          <h1>Platform command center</h1>
          <p>
            Track tenant health, subscription pressure, and onboarding gaps without dropping into
            pharmacy-level operations.
          </p>

          <div className="platform-hero-chips">
            <span>{organizations.length} pharmacies</span>
            <span>{statusCounts.trial} in trial</span>
            <span>{statusCounts.suspended} suspended</span>
            <span>{totalUsers} total users</span>
          </div>

          <div className="platform-hero-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate('/tenant-admin')}>
              Open Tenant Admin
              <ArrowRight size={16} />
            </button>
          </div>
        </div>

        <aside className="platform-hero-panel">
          <div className="platform-panel-heading">
            <ShieldCheck size={18} />
            <div>
              <span className="platform-panel-label">Right now</span>
              <strong>Platform attention</strong>
            </div>
          </div>

          <div className="platform-panel-metrics">
            <div className="platform-panel-metric">
              <span>Renewals due soon</span>
              <strong>{renewalWatchlist.length}</strong>
            </div>
            <div className="platform-panel-metric">
              <span>Setup gaps</span>
              <strong>{setupAlerts.length}</strong>
            </div>
            <div className="platform-panel-metric">
              <span>Cancelled tenants</span>
              <strong>{statusCounts.cancelled}</strong>
            </div>
          </div>

          <p className="platform-panel-note">
            Use this view as the super-admin landing page so platform work stays separate from
            tenant sales, stock, and claims screens.
          </p>
        </aside>
      </section>

      {error && <div className="platform-alert">{error}</div>}

      <section className="platform-stats-grid" aria-label="Platform summary metrics">
        {summaryCards.map((card) => (
          <article key={card.title} className={`platform-stat-card tone-${card.tone}`}>
            <div className="platform-stat-icon">
              <card.icon size={22} />
            </div>
            <div className="platform-stat-copy">
              <span className="platform-stat-title">{card.title}</span>
              <strong className="platform-stat-value">{card.value}</strong>
              <span className="platform-stat-subtitle">{card.subtitle}</span>
            </div>
          </article>
        ))}
      </section>

      <section className="platform-section">
        <div className="platform-section-header">
          <div>
            <h2>Tenant status</h2>
            <p>Current lifecycle spread across the full platform.</p>
          </div>
        </div>

        <div className="platform-status-grid">
          {Object.entries(statusCounts).map(([status, count]) => (
            <article key={status} className={`platform-status-card status-${status}`}>
              <span className="platform-status-label">{STATUS_LABELS[status]}</span>
              <strong className="platform-status-value">{count}</strong>
            </article>
          ))}
        </div>
      </section>

      <div className="platform-grid">
        <section className="platform-section platform-card-list">
          <div className="platform-section-header">
            <div>
              <h2>Renewal watchlist</h2>
              <p>Trials and subscriptions ending within the next {PLATFORM_ALERT_WINDOW_DAYS} days.</p>
            </div>
          </div>

          {renewalWatchlist.length === 0 ? (
            <div className="platform-empty-state">
              <Clock3 size={18} />
              <p>No renewals are due in the next two weeks.</p>
            </div>
          ) : (
            <div className="platform-list">
              {renewalWatchlist.map((organization) => (
                <article key={organization.id} className="platform-list-item">
                  <div>
                    <strong>{organization.name}</strong>
                    <p>{formatLifecycleLabel(organization, organization.daysUntil)}</p>
                  </div>
                  <div className="platform-list-meta">
                    <span className={`status-pill status-${organization.status}`}>
                      {STATUS_LABELS[organization.status]}
                    </span>
                    <span>{fullDateFormatter.format(organization.lifecycleDate)}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="platform-section platform-card-list">
          <div className="platform-section-header">
            <div>
              <h2>Onboarding attention</h2>
              <p>Tenants that still need setup help or missing data cleanup.</p>
            </div>
          </div>

          {setupAlerts.length === 0 ? (
            <div className="platform-empty-state">
              <ShieldCheck size={18} />
              <p>No setup gaps detected from the current tenant snapshot.</p>
            </div>
          ) : (
            <div className="platform-list">
              {setupAlerts.map((alert) => (
                <article key={alert.id} className="platform-list-item platform-list-item-alert">
                  <div>
                    <strong>{alert.organizationName}</strong>
                    <p>{alert.message}</p>
                  </div>
                  <AlertTriangle size={18} />
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="platform-section">
        <div className="platform-section-header">
          <div>
            <h2>Recent tenant activity</h2>
            <p>Latest organization records touched from the platform snapshot.</p>
          </div>
        </div>

        {recentActivity.length === 0 ? (
          <div className="platform-empty-state">
            <Building2 size={18} />
            <p>No tenant records are available yet.</p>
          </div>
        ) : (
          <div className="platform-table-wrap">
            <table className="platform-table">
              <thead>
                <tr>
                  <th>Pharmacy</th>
                  <th>Status</th>
                  <th>Tier</th>
                  <th>Users</th>
                  <th>Branches</th>
                  <th>Last updated</th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.map((organization) => (
                  <tr key={organization.id}>
                    <td>{organization.name}</td>
                    <td>
                      <span className={`status-pill status-${organization.status}`}>
                        {STATUS_LABELS[organization.status]}
                      </span>
                    </td>
                    <td>{organization.subscriptionTier}</td>
                    <td>{organization.userCount}</td>
                    <td>{organization.branchCount}</td>
                    <td>{shortDateTimeFormatter.format(new Date(organization.updatedAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export default SuperAdminDashboard
