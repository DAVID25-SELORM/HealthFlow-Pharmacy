import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Menu, Search, Bell, LogOut, Wifi, WifiOff, MonitorCheck } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { subscribeToHealthflowDataChanged } from '../../lib/appEvents'
import { useNotification } from '../../context/NotificationContext'
import { useTenant } from '../../context/TenantContext'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { isSupabaseConfigured } from '../../lib/supabase'
import { getClaimsStatistics } from '../../services/claimsService'
import { getExpiringDrugs, getLowStockDrugs } from '../../services/drugService'
import { subscribeSystemHealthPolling } from '../../services/systemHealthService'
import {
  CONNECTIVITY_MODES,
  getConnectivityState,
  refreshConnectivityState,
  subscribeConnectivity,
} from '../../services/connectivityService'
import { CLAIMS_ROLES, INVENTORY_ROLES, SYSTEM_HEALTH_ROLES, hasRole } from '../../utils/roles'
import { getRoleLabel } from '../../utils/roleLabels'
import './TopBar.css'

const TopBar = ({ isSidebarOpen, onMenuToggle, pageTitle }) => {
  const [quickSearch, setQuickSearch] = useState('')
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [alerts, setAlerts] = useState([])
  const [systemHealth, setSystemHealth] = useState(null)
  const [systemHealthLoading, setSystemHealthLoading] = useState(false)
  const {
    displayName,
    role,
    assignedRoles = [],
    setActiveRole,
    branch,
    canManageInventory,
    canManageClaims,
    canViewReports,
    loading: authLoading,
    signOut,
  } = useAuth()
  const { canUseClaims, tierLimits } = useTenant()
  const { notify } = useNotification()
  const isOnline = useOnlineStatus()
  const [connectivity, setConnectivity] = useState(getConnectivityState())
  const navigate = useNavigate()
  const location = useLocation()
  const alertsRef = useRef(null)

  const avatarName = encodeURIComponent(displayName)
  const canUseInventorySearch = canManageInventory || hasRole(role, INVENTORY_ROLES)
  const canUseClaimAlerts = canManageClaims || hasRole(role, CLAIMS_ROLES)
  const canViewSystemHealth = hasRole(role, SYSTEM_HEALTH_ROLES)
  const authReady = !authLoading && Boolean(role)
  const searchTarget = canUseInventorySearch ? '/inventory' : '/sales'

  const notificationCount = useMemo(
    () => alerts.filter((alert) => alert.count > 0).length,
    [alerts]
  )

  const connectionLabel = useMemo(() => {
    if (connectivity.mode === CONNECTIVITY_MODES.ONLINE_CLOUD) return '🟢 Online Cloud'
    if (connectivity.mode === CONNECTIVITY_MODES.ONLINE_LOCAL_SYNC) return '🟡 Local Sync Mode'
    if (connectivity.mode === CONNECTIVITY_MODES.OFFLINE_LOCAL) return '🔴 Offline Local Mode'
    return '🔴 Offline'
  }, [connectivity.mode])

  const connectionClass = useMemo(() => {
    if (connectivity.mode === CONNECTIVITY_MODES.ONLINE_CLOUD) return 'online'
    if (connectivity.mode === CONNECTIVITY_MODES.ONLINE_LOCAL_SYNC) return 'local-sync'
    return 'offline'
  }, [connectivity.mode])

  const systemHealthMeta = useMemo(() => {
    if (!canViewSystemHealth) return null
    if (systemHealthLoading && !systemHealth) {
      return { label: 'Checking', className: 'checking', title: 'Checking system health' }
    }
    if (systemHealth?.status === 'ok') {
      return { label: 'Healthy', className: 'ok', title: 'System health is healthy' }
    }
    if (systemHealth?.status === 'fail') {
      return { label: 'Issue', className: 'fail', title: 'System health needs attention' }
    }
    if (systemHealth?.status === 'warn') {
      return { label: 'Review', className: 'warn', title: 'System health should be reviewed' }
    }
    return { label: 'Health', className: 'unknown', title: 'Open system health' }
  }, [canViewSystemHealth, systemHealth, systemHealthLoading])

  const loadAlerts = useCallback(async () => {
    if (!authReady || !isSupabaseConfigured() || (!canUseInventorySearch && !canUseClaimAlerts)) {
      setAlerts([])
      return
    }

    try {
      const canViewClaimAlerts = canUseClaims && tierLimits.hasClaims && canUseClaimAlerts
      const [lowStock, expiring, claimStats] = await Promise.all([
        canUseInventorySearch ? getLowStockDrugs() : Promise.resolve([]),
        canUseInventorySearch ? getExpiringDrugs() : Promise.resolve([]),
        canViewClaimAlerts ? getClaimsStatistics() : Promise.resolve({ pending: 0 }),
      ])

      const nextAlerts = canUseInventorySearch
        ? [
            {
              id: 'low-stock',
              title: 'Low stock medicines',
              description: `${lowStock.length} item(s) need attention.`,
              count: lowStock.length,
              path: '/inventory?filter=low',
            },
            {
              id: 'expiring',
              title: 'Expiring soon',
              description: `${expiring.length} item(s) are approaching expiry.`,
              count: expiring.length,
              path: '/inventory?filter=expiring',
            },
          ]
        : []

      if (canViewClaimAlerts) {
        nextAlerts.push({
          id: 'pending-claims',
          title: 'Pending claims',
          description: `${claimStats.pending} claim(s) are waiting for review.`,
          count: claimStats.pending,
          path: '/claims?tab=pending',
        })
      }

      setAlerts(nextAlerts)
    } catch (error) {
      console.error('Unable to load top bar alerts:', error)
      setAlerts([])
    }
  }, [authReady, canUseClaimAlerts, canUseClaims, canUseInventorySearch, tierLimits.hasClaims])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const routeSearch = params.get('search') || ''

    if (location.pathname === '/inventory' || location.pathname === '/sales') {
      setQuickSearch(routeSearch)
      return
    }

    setQuickSearch('')
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!authReady) {
      return
    }

    void loadAlerts()
  }, [authReady, loadAlerts])

  useEffect(() => {
    if (!authReady || !canViewSystemHealth) {
      setSystemHealth(null)
      setSystemHealthLoading(false)
      return undefined
    }

    setSystemHealthLoading(true)
    return subscribeSystemHealthPolling(
      (health) => {
        setSystemHealth(health)
        setSystemHealthLoading(false)
      },
      { canViewReports, activeRole: role }
    )
  }, [authReady, canViewReports, canViewSystemHealth, role])

  useEffect(() => {
    const unsubscribe = subscribeConnectivity(setConnectivity)
    void refreshConnectivityState()
    return unsubscribe
  }, [isOnline])

  useEffect(() => {
    if (!alertsOpen) {
      return
    }

    void loadAlerts()
  }, [alertsOpen, loadAlerts])

  useEffect(() => {
    return subscribeToHealthflowDataChanged(() => {
      void loadAlerts()
    })
  }, [loadAlerts])

  useEffect(() => {
    if (!alertsOpen) {
      return undefined
    }

    const handleOutsideClick = (event) => {
      if (alertsRef.current && !alertsRef.current.contains(event.target)) {
        setAlertsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
    }
  }, [alertsOpen])

  const handleLogout = async () => {
    try {
      await signOut()
    } catch (error) {
      console.error('Error signing out:', error)
      notify('Unable to sign out at the moment. Please try again.', 'error')
    }
  }

  const handleSearchSubmit = (event) => {
    event.preventDefault()

    const term = quickSearch.trim()
    if (!term) {
      notify('Enter a drug name or batch number to search.', 'info')
      return
    }

    navigate({
      pathname: searchTarget,
      search: `?search=${encodeURIComponent(term)}`,
    })
  }

  const handleAlertSelect = (alertPath) => {
    setAlertsOpen(false)
    navigate(alertPath)
  }

  return (
    <header className="topbar">
      <div className="topbar-leading">
        <button
          type="button"
          className="topbar-menu-btn"
          aria-label={isSidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
          onClick={onMenuToggle}
        >
          <Menu size={20} />
        </button>
        <span className="topbar-page-title">{pageTitle}</span>

        <form className="topbar-search-container" onSubmit={handleSearchSubmit}>
          <Search size={20} className="topbar-search-icon" />
          <input
            id="topbar-search"
            name="topbarSearch"
            type="text"
            placeholder="Search drugs or scan barcode..."
            className="topbar-search-input"
            value={quickSearch}
            onChange={(event) => setQuickSearch(event.target.value)}
          />
          <button
            type="submit"
            className="topbar-search-submit"
            aria-label="Search inventory or POS"
          >
            Search
          </button>
        </form>
      </div>

      <div className="topbar-actions">
        {systemHealthMeta && (
          <button
            type="button"
            className={`system-health-topbar-badge ${systemHealthMeta.className}`}
            title={systemHealthMeta.title}
            onClick={() => navigate('/system-health')}
          >
            <MonitorCheck size={15} />
            <span>System: {systemHealthMeta.label}</span>
          </button>
        )}

        <span
          className={`connection-status ${connectionClass}`}
          title={connectionLabel}
        >
          {connectivity.mode === CONNECTIVITY_MODES.OFFLINE_NO_SERVER ? <WifiOff size={16} /> : <Wifi size={16} />}
          {connectionLabel}
        </span>

        <div className="topbar-alerts" ref={alertsRef}>
          <button
            className="notification-btn"
            type="button"
            onClick={() => setAlertsOpen((current) => !current)}
            aria-label="View operational alerts"
            aria-expanded={alertsOpen}
          >
            <Bell size={20} />
            {notificationCount > 0 && <span className="notification-badge">{notificationCount}</span>}
          </button>

          {alertsOpen && (
            <div className="alerts-panel">
              <div className="alerts-panel-header">
                <strong>Operational Alerts</strong>
                <span>{notificationCount > 0 ? `${notificationCount} active` : 'All clear'}</span>
              </div>

              {alerts.filter((alert) => alert.count > 0).length === 0 ? (
                <p className="alerts-empty">No actionable alerts right now.</p>
              ) : (
                <div className="alerts-list">
                  {alerts
                    .filter((alert) => alert.count > 0)
                    .map((alert) => (
                      <button
                        key={alert.id}
                        type="button"
                        className="alerts-item"
                        onClick={() => handleAlertSelect(alert.path)}
                      >
                        <span className="alerts-item-title">{alert.title}</span>
                        <span className="alerts-item-description">{alert.description}</span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="user-profile">
          <img
            src={`https://ui-avatars.com/api/?name=${avatarName}&background=16a085&color=fff`}
            alt={`${displayName} avatar`}
            className="user-avatar"
          />
          <div className="user-info">
            <span className="user-name">{displayName}</span>
            {assignedRoles.length > 1 ? (
              <label className="active-role-switcher">
                <span className="sr-only">Active role</span>
                <select
                  id="active-role"
                  name="activeRole"
                  value={role}
                  onChange={(event) => setActiveRole(event.target.value)}
                  title="Switch active role"
                >
                  {assignedRoles.map((assignedRole) => (
                    <option key={assignedRole} value={assignedRole}>
                      {getRoleLabel(assignedRole)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="user-role">{getRoleLabel(role)}</span>
            )}
            {branch && <span className="branch-topbar-badge">{branch.name}</span>}
          </div>
          <button className="notification-btn" type="button" onClick={handleLogout} title="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </header>
  )
}

export default TopBar
