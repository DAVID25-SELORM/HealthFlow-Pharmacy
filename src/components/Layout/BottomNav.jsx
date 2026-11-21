import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { MoreHorizontal, X } from 'lucide-react'
import { preloadRouteModule } from '../../routes/routeModules'
import { groupNavigationItems, pickBottomTabs, useNavigationItems } from './useNavigationItems'
import './BottomNav.css'

const isOnPath = (pathname, path) => pathname === path || pathname.startsWith(`${path}/`)

// Phone navigation: the places used all day sit at the bottom within thumb reach;
// everything else is one tap away in the More sheet, grouped like the sidebar.
const BottomNav = () => {
  const { items } = useNavigationItems()
  const { pathname } = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const closeButtonRef = useRef(null)

  const { tabs, raisedIndex, moreItems } = useMemo(() => pickBottomTabs(items), [items])
  const moreGroups = useMemo(() => groupNavigationItems(moreItems), [moreItems])
  const moreIsCurrent = moreItems.some((item) => isOnPath(pathname, item.path))

  useEffect(() => {
    setMoreOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!moreOpen) return undefined
    closeButtonRef.current?.focus()
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [moreOpen])

  if (tabs.length === 0 && moreItems.length === 0) return null

  const preload = (path) => ({
    onMouseEnter: () => preloadRouteModule(path),
    onFocus: () => preloadRouteModule(path),
    onTouchStart: () => preloadRouteModule(path),
  })

  return (
    <>
      {moreOpen && (
        <div className="bottom-sheet-layer">
          <button
            type="button"
            className="bottom-sheet-backdrop"
            aria-label="Close more menu"
            onClick={() => setMoreOpen(false)}
          />
          <section className="bottom-sheet" role="dialog" aria-modal="true" aria-label="More">
            <div className="bottom-sheet-handle" aria-hidden="true" />
            <div className="bottom-sheet-header">
              <h2>More</h2>
              <button
                type="button"
                className="bottom-sheet-close"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                ref={closeButtonRef}
              >
                <X size={20} />
              </button>
            </div>
            <div className="bottom-sheet-body">
              {moreGroups.map((group) => (
                <div className="bottom-sheet-group" key={group.id}>
                  <div className="bottom-sheet-group-label">{group.label}</div>
                  <div className="bottom-sheet-grid">
                    {group.items.map((item) => (
                      <NavLink
                        key={item.path}
                        to={item.path}
                        className={({ isActive }) => `bottom-sheet-tile ${isActive ? 'active' : ''}`}
                        {...preload(item.path)}
                      >
                        <span className="bottom-sheet-tile-icon">
                          <item.icon size={24} />
                        </span>
                        <span className="bottom-sheet-tile-label">{item.label}</span>
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      <nav className="bottom-nav" aria-label="Main navigation">
        {tabs.map((item, index) => {
          const raised = index === raisedIndex
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => `bottom-nav-tab ${isActive ? 'active' : ''} ${raised ? 'raised' : ''}`}
              {...preload(item.path)}
            >
              <span className="bottom-nav-icon">
                <item.icon size={raised ? 26 : 24} />
              </span>
              <span className="bottom-nav-label">{item.tabLabel}</span>
            </NavLink>
          )
        })}
        {moreItems.length > 0 && (
          <button
            type="button"
            className={`bottom-nav-tab ${moreOpen || moreIsCurrent ? 'active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((current) => !current)}
          >
            <span className="bottom-nav-icon">
              <MoreHorizontal size={24} />
            </span>
            <span className="bottom-nav-label">More</span>
          </button>
        )}
      </nav>
    </>
  )
}

export default BottomNav
