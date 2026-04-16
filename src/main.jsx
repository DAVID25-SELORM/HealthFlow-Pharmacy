import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext'
import { TenantProvider } from './context/TenantContext'
import { NotificationProvider } from './context/NotificationContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <NotificationProvider>
      <AuthProvider>
        <TenantProvider>
          <App />
        </TenantProvider>
      </AuthProvider>
    </NotificationProvider>
  </React.StrictMode>,
)
