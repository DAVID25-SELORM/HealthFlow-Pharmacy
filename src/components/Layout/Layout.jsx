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
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import './Layout.css'

const pageTitles = {
  '/dashboard': 'Dashboard',
  '/inventory': 'Inventory',
  '/sales': 'Sales (POS)',
  '/patients': 'Patients',
  '/claims': 'Claims',
  '/purchases': 'Purchases',
  '/nhis': 'NHIS',
  '/reports': 'Reports',
  '/accounting': 'Accounting',
  '/settings': 'Settings',
}

const Layout = () => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const location = useLocation()
  const pageTitle = pageTitles[location.pathname] || 'HealthFlow'

  useEffect(() => {
    setIsSidebarOpen(false)
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
        if (cancelled || !settings) return
        applyFacilityTheme(settings)
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
    <div className={`app-layout ${isSidebarOpen ? 'sidebar-open' : ''}`}>
      <Seo noindex title="Workspace" />
      <ProductionMetricsMonitor />
      <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
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
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default Layout
