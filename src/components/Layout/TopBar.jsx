import { useState } from 'react'
import { Menu, Search, Bell, LogOut } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useNotification } from '../../context/NotificationContext'
import './TopBar.css'

const TopBar = ({ isSidebarOpen, onMenuToggle }) => {
  const [notifications] = useState(3)
  const { displayName, role, signOut } = useAuth()
  const { notify } = useNotification()

  const avatarName = encodeURIComponent(displayName)

  const handleLogout = async () => {
    try {
      await signOut()
    } catch (error) {
      console.error('Error signing out:', error)
      notify('Unable to sign out at the moment. Please try again.', 'error')
    }
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

        <div className="topbar-search-container">
          <Search size={20} className="topbar-search-icon" />
          <input 
            type="text" 
            placeholder="Search drugs or scan barcode..." 
            className="topbar-search-input"
          />
        </div>
      </div>

      <div className="topbar-actions">
        <button className="notification-btn" type="button">
          <Bell size={20} />
          {notifications > 0 && (
            <span className="notification-badge">{notifications}</span>
          )}
        </button>

        <div className="user-profile">
          <img 
            src={`https://ui-avatars.com/api/?name=${avatarName}&background=16a085&color=fff`} 
            alt="User" 
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
