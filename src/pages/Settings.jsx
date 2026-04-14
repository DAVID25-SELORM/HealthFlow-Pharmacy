import { User, Lock, Bell, Building, Palette } from 'lucide-react'
import './Settings.css'

const Settings = () => {
  return (
    <div className="settings-page">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Manage your pharmacy system preferences</p>
      </div>

      <div className="settings-grid">
        <div className="settings-card">
          <div className="card-icon">
            <Building size={24} />
          </div>
          <h3>Pharmacy Information</h3>
          <p>Update pharmacy name, address, and contact details</p>
          <button className="btn btn-outline">Edit Details</button>
        </div>

        <div className="settings-card">
          <div className="card-icon">
            <User size={24} />
          </div>
          <h3>User Management</h3>
          <p>Add or manage user accounts and permissions</p>
          <button className="btn btn-outline">Manage Users</button>
        </div>

        <div className="settings-card">
          <div className="card-icon">
            <Bell size={24} />
          </div>
          <h3>Notifications</h3>
          <p>Configure alerts for low stock, expiry, and claims</p>
          <button className="btn btn-outline">Configure</button>
        </div>

        <div className="settings-card">
          <div className="card-icon">
            <Lock size={24} />
          </div>
          <h3>Security</h3>
          <p>Update password and security settings</p>
          <button className="btn btn-outline">Change Password</button>
        </div>

        <div className="settings-card">
          <div className="card-icon">
            <Palette size={24} />
          </div>
          <h3>Appearance</h3>
          <p>Customize theme and display preferences</p>
          <button className="btn btn-outline">Customize</button>
        </div>
      </div>

      <div className="about-section">
        <h2>About HealthFlow Pharmacy</h2>
        <p>Version 1.0.0</p>
        <p className="developer-credit">
          Developed by <strong>David Gabion Selorm</strong>
        </p>
        <p className="contact">
          Email: gabiondavidselorm@gmail.com | Business: zittechgh@gmail.com
        </p>
        <p className="copyright">© 2026 HealthFlow Pharmacy. All rights reserved.</p>
      </div>
    </div>
  )
}

export default Settings
