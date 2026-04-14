import { useState } from 'react'
import { Search, Bell, User, ChevronDown } from 'lucide-react'
import './TopBar.css'

const TopBar = () => {
  const [notifications] = useState(3)

  return (
    <header className="topbar">
      <div className="search-container">
        <Search size={20} className="search-icon" />
        <input 
          type="text" 
          placeholder="Search drugs or scan barcode..." 
          className="search-input"
        />
      </div>

      <div className="topbar-actions">
        <button className="notification-btn">
          <Bell size={20} />
          {notifications > 0 && (
            <span className="notification-badge">{notifications}</span>
          )}
        </button>

        <div className="user-profile">
          <img 
            src="https://ui-avatars.com/api/?name=Admin&background=16a085&color=fff" 
            alt="User" 
            className="user-avatar"
          />
          <div className="user-info">
            <span className="user-name">Admin</span>
            <span className="user-role">Administrator</span>
          </div>
          <ChevronDown size={16} />
        </div>
      </div>
    </header>
  )
}

export default TopBar
