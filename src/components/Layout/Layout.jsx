import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { isSupabaseConfigured } from '../../lib/supabase'
import { getPharmacySettings } from '../../services/settingsService'
import Seo from '../Seo/Seo'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import './Layout.css'

const isHexColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value || '').trim())

const Layout = () => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const location = useLocation()

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
    if (!isSupabaseConfigured()) {
      return
    }

    let cancelled = false
    getPharmacySettings()
      .then((settings) => {
        if (cancelled || !settings) return
        const root = document.documentElement
        const primaryColor = settings.theme_primary_color
        const secondaryColor = settings.theme_secondary_color
        const accentColor = settings.theme_accent_color

        if (isHexColor(primaryColor)) {
          root.style.setProperty('--primary', primaryColor)
          root.style.setProperty('--primary-dark', primaryColor)
          root.style.setProperty('--primary-light', primaryColor)
        }
        if (isHexColor(secondaryColor)) {
          root.style.setProperty('--secondary', secondaryColor)
          root.style.setProperty('--secondary-light', secondaryColor)
        }
        if (isHexColor(accentColor)) {
          root.style.setProperty('--warning', accentColor)
        }
      })
      .catch((error) => {
        console.warn('Unable to apply facility theme settings:', error)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className={`app-layout ${isSidebarOpen ? 'sidebar-open' : ''}`}>
      <Seo noindex title="Workspace" />
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
        />
        <main className="page-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default Layout
