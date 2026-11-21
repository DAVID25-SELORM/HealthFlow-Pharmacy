import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { isSupabaseConfigured } from '../../lib/supabase'
import { getPharmacyThemeSettings } from '../../services/settingsService'
import {
  applyFacilityTheme,
  FACILITY_THEME_UPDATED_EVENT,
} from '../../utils/facilityTheme'
import Seo from '../Seo/Seo'
import ProductionMetricsMonitor from '../Diagnostics/ProductionMetricsMonitor'
import FacilityContactReporter from '../FacilityContactReporter'
import SubscriptionNotice from '../SubscriptionNotice'
import ClaimExportAlerts from '../ClaimExportAlerts'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import TopBar from './TopBar'
import './Layout.css'

const SIDEBAR_COLLAPSED_KEY = 'healthflow.sidebar.collapsed'
const DESKTOP_QUERY = '(min-width: 1025px)'

const readCollapsedPreference = () => {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

const useIsDesktop = () => {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DESKTOP_QUERY).matches
      : true
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia(DESKTOP_QUERY)
    const handleChange = (event) => setIsDesktop(event.matches)
    setIsDesktop(query.matches)
    query.addEventListener?.('change', handleChange)
    return () => query.removeEventListener?.('change', handleChange)
  }, [])

  return isDesktop
}

const pageTitles = {
  '/search': 'General search',
  '/dashboard': 'Dashboard',
  '/billing': 'Payments',
  '/export-notifications': 'Export notifications',
  '/inventory': 'Inventory',
  '/sales': 'Sales (POS)',
  '/patients': 'Patients',
  '/claims': 'Claims',
  '/purchases': 'Purchases',
  '/reorder': 'Reorder Centre',
  '/nhis': 'NHIS',
  '/reports': 'Reports',
  '/accounting': 'Accounting',
  '/settings': 'Settings',
}

const Layout = () => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [collapsePreference, setCollapsePreference] = useState(readCollapsedPreference)
  const isDesktop = useIsDesktop()
  // The slim icon rail is a computer feature; tablets and phones keep their drawer / bottom bar.
  const isSidebarCollapsed = collapsePreference && isDesktop
  const location = useLocation()

  const toggleSidebarCollapsed = () => {
    setCollapsePreference((current) => {
      const next = !current
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
      } catch {
        // The preference simply is not remembered.
      }
      return next
    })
  }
  const pageTitle = pageTitles[location.pathname] || 'HealthFlow'

  useEffect(() => {
    setIsSidebarOpen(false)
    window.scrollTo(0, 0)
    document.querySelector('.page-content')?.scrollTo(0, 0)
  }, [location.pathname])

  useEffect(() => {
    const isMobileViewport = window.innerWidth <= 1024
    document.body.style.overflow = isSidebarOpen && isMobileViewport ? 'hidden' : ''

    return () => {
      document.body.style.overflow = ''
    }
  }, [isSidebarOpen])

  useEffect(() => {
    const handleThemeUpdate = (event) => applyFacilityTheme(event.detail)
    window.addEventListener(FACILITY_THEME_UPDATED_EVENT, handleThemeUpdate)

    if (!isSupabaseConfigured()) {
      return () => window.removeEventListener(FACILITY_THEME_UPDATED_EVENT, handleThemeUpdate)
    }

    let cancelled = false
    getPharmacyThemeSettings()
      .then((settings) => {
        if (cancelled) return
        applyFacilityTheme(settings || {})
      })
      .catch((error) => {
        console.warn('Unable to apply facility theme settings:', error)
      })

    return () => {
      cancelled = true
      window.removeEventListener(FACILITY_THEME_UPDATED_EVENT, handleThemeUpdate)
    }
  }, [])

  return (
    <div className={`app-layout ${isSidebarOpen ? 'sidebar-open' : ''} ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Seo noindex title="Workspace" />
      <ProductionMetricsMonitor />
      <FacilityContactReporter />
      <Sidebar
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        collapsed={isSidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
      />
      <button
        type="button"
        className={`sidebar-backdrop ${isSidebarOpen ? 'visible' : ''}`}
        aria-label="Close navigation"
        onClick={() => setIsSidebarOpen(false)}
      />
      <div className="main-content">
        <TopBar
          isSidebarOpen={isSidebarOpen}
          onMenuToggle={() => setIsSidebarOpen((current) => !current)}
          pageTitle={pageTitle}
        />
        <main className="page-content">
          {location.pathname === '/billing' && <SubscriptionNotice />}
          <ClaimExportAlerts visible={location.pathname === '/export-notifications'} />
          <Outlet />
        </main>
      </div>
      <BottomNav />
    </div>
  )
}

export default Layout
