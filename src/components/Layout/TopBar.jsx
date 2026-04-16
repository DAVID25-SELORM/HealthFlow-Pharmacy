import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Menu, Search, Bell, LogOut } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { subscribeToHealthflowDataChanged } from '../../lib/appEvents'
import { useNotification } from '../../context/NotificationContext'
import { isSupabaseConfigured } from '../../lib/supabase'
import { getClaimsStatistics } from '../../services/claimsService'
import { getExpiringDrugs, getLowStockDrugs } from '../../services/drugService'
import './TopBar.css'

const TopBar = ({ isSidebarOpen, onMenuToggle }) => {
  const [quickSearch, setQuickSearch] = useState('')
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [alerts, setAlerts] = useState([])
  const { displayName, role, signOut } = useAuth()
  const { notify } = useNotification()
  const navigate = useNavigate()
  const location = useLocation()
  const alertsRef = useRef(null)

  const avatarName = encodeURIComponent(displayName)
  const searchTarget = ['admin', 'pharmacist'].includes(role) ? '/inventory' : '/sales'

  const notificationCount = useMemo(
    () => alerts.filter((alert) => alert.count > 0).length,
    [alerts]
  )

  const loadAlerts = useCallback(async () => {
    if (!isSupabaseConfigured() || !['admin', 'pharmacist'].includes(role)) {
      setAlerts([])
      return
    }

    try {
      const [lowStock, expiring, claimStats] = await Promise.all([
        getLowStockDrugs(),
        getExpiringDrugs(),
        getClaimsStatistics(),
      ])

      setAlerts([
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
        {
          id: 'pending-claims',
          title: 'Pending claims',
          description: `${claimStats.pending} claim(s) are waiting for review.`,
          count: claimStats.pending,
          path: '/claims?tab=pending',
        },
      ])
    } catch (error) {
      console.error('Unable to load top bar alerts:', error)
      setAlerts([])
    }
  }, [role])

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
    void loadAlerts()
  }, [loadAlerts, location.pathname])

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

        <form className="topbar-search-container" onSubmit={handleSearchSubmit}>
          <Search size={20} className="topbar-search-icon" />
          <input
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
            <span className="user-role">{role}</span>
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
