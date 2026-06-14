import React from 'react'
import ReactDOM from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext'
import { TenantProvider } from './context/TenantContext'
import { NotificationProvider } from './context/NotificationContext'
import registerServiceWorker from './registerServiceWorker'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HelmetProvider>
      <NotificationProvider>
        <AuthProvider>
          <TenantProvider>
            <App />
          </TenantProvider>
        </AuthProvider>
      </NotificationProvider>
    </HelmetProvider>
  </React.StrictMode>,
)

registerServiceWorker()
