import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronUp, ChevronsLeft, ChevronsRight, X } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { getRoleLabel } from '../../utils/roleLabels'
import { preloadRouteModule } from '../../routes/routeModules'
import { useBranchUpdateNotice } from '../../hooks/useBranchUpdateNotice'
import { useNavigationItems } from './useNavigationItems'
import './Sidebar.css'

const GROUPS_STORAGE_KEY = 'healthflow.sidebar.groups'

const readStoredGroups = () => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GROUPS_STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const getInitials = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'U'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

const Sidebar = ({ isOpen, onClose, collapsed = false, onToggleCollapsed, classic = false }) => {
  const { groups, facilityName, facilityLogo, organization } = useNavigationItems()
  const { displayName, role } = useAuth()
  const { pathname } = useLocation()
  const updateNotice = useBranchUpdateNotice()
  const badgeFor = (item) =>
    item.path === '/updates' && updateNotice?.available ? (
      <span className="nav-item-badge">New</span>
    ) : null
  const [storedGroups, setStoredGroups] = useState(readStoredGroups)

  const activeGroupId = useMemo(() => {
    const match = groups.find((group) =>
      group.items.some((item) => pathname === item.path || pathname.startsWith(`${item.path}/`))
    )
    return match?.id || null
  }, [groups, pathname])

  useEffect(() => {
    try {
      window.localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(storedGroups))
    } catch {
      // The menu still works without remembering which groups were folded.
    }
  }, [storedGroups])

  const isGroupOpen = (group) =>
    collapsed || group.id === activeGroupId || (storedGroups[group.id] ?? group.defaultOpen)

  const toggleGroup = (group) => {
    setStoredGroups((current) => ({ ...current, [group.id]: !(current[group.id] ?? group.defaultOpen) }))
  }

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        <img src={facilityLogo} alt={`${facilityName} logo`} className="sidebar-brand-logo" />
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-name">{facilityName}</span>
          <span className="sidebar-brand-sub">{organization?.organization_type || 'Facility'} workspace</span>
        </div>
        {!classic && (
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
          </button>
        )}
        <button type="button" className="sidebar-close" onClick={onClose} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        {classic && (
          <div className="nav-group-items">
            {groups.flatMap((group) => group.items).map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={onClose}
                onMouseEnter={() => preloadRouteModule(item.path)}
                onFocus={() => preloadRouteModule(item.path)}
                onTouchStart={() => preloadRouteModule(item.path)}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <item.icon size={20} />
                <span className="nav-item-label">{item.label}</span>
                {badgeFor(item)}
              </NavLink>
            ))}
          </div>
        )}
        {!classic && groups.map((group) => {
          const open = isGroupOpen(group)
          return (
            <div className="nav-group" key={group.id}>
              {collapsed ? (
                <div className="nav-group-divider" aria-hidden="true" />
              ) : (
                <button
                  type="button"
                  className="nav-group-toggle"
                  aria-expanded={open}
                  aria-controls={`nav-group-${group.id}`}
                  onClick={() => toggleGroup(group)}
                  disabled={group.id === activeGroupId}
                >
                  <span className="nav-group-label">{group.label}</span>
                  {!open && <span className="nav-group-count">{group.items.length}</span>}
                  {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              )}
              {open && (
                <div className="nav-group-items" id={`nav-group-${group.id}`}>
                  {group.items.map((item) => (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      onClick={onClose}
                      onMouseEnter={() => preloadRouteModule(item.path)}
                      onFocus={() => preloadRouteModule(item.path)}
                      onTouchStart={() => preloadRouteModule(item.path)}
                      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                      title={collapsed ? item.label : undefined}
                      aria-label={collapsed ? item.label : undefined}
                    >
                      <item.icon size={20} />
                      <span className="nav-item-label">{item.label}</span>
                      {badgeFor(item)}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <span className="sidebar-user-avatar" aria-hidden="true">{getInitials(displayName)}</span>
          <span className="sidebar-user-text">
            <span className="sidebar-user-name">{displayName}</span>
            <span className="sidebar-user-role">{getRoleLabel(role)}</span>
          </span>
        </div>
        <div className="sidebar-footer-links">
          <Link className="sidebar-terms-link" to="/terms" onClick={onClose}>
            Terms and Conditions
          </Link>
          <a
            className="sidebar-powered-by"
            href="https://neondigitaltechnologies.com"
            target="_blank"
            rel="noreferrer"
          >
            Powered by Daventra Technologies
          </a>
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
