import React from 'react'
import ReactDOM from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext'
import { TenantProvider } from './context/TenantContext'
import { NotificationProvider } from './context/NotificationContext'
import AppDialogProvider from './components/AppDialog/AppDialogProvider'
import registerServiceWorker from './registerServiceWorker'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HelmetProvider>
      <NotificationProvider>
        <AuthProvider>
          <TenantProvider>
            <AppDialogProvider>
              <App />
            </AppDialogProvider>
          </TenantProvider>
        </AuthProvider>
      </NotificationProvider>
    </HelmetProvider>
  </React.StrictMode>,
)

registerServiceWorker()
