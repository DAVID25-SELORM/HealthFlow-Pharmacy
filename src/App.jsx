import { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/Auth/ProtectedRoute'
import RoleRoute from './components/Auth/RoleRoute'
import { useAuth } from './context/AuthContext'
import { useTenant } from './context/TenantContext'
import {
  ACCOUNTING_ROLES,
  ACTIVITY_LOG_ROLES,
  CLAIMS_ROLES,
  INVENTORY_ROLES,
  NHIS_ROLES,
  PATIENT_ROLES,
  PURCHASES_ROLES,
  REPORT_ROLES,
  SALES_ROLES,
  SETTINGS_ROLES,
} from './utils/roles'
import './App.css'

const Layout = lazy(() => import('./components/Layout/Layout'))
const DashboardHome = lazy(() => import('./pages/DashboardHome'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Sales = lazy(() => import('./pages/Sales'))
const Patients = lazy(() => import('./pages/Patients'))
const Claims = lazy(() => import('./pages/Claims'))
const Reports = lazy(() => import('./pages/Reports'))
const Accounting = lazy(() => import('./pages/Accounting'))
const Settings = lazy(() => import('./pages/Settings'))
const TenantAdmin = lazy(() => import('./pages/TenantAdmin'))
const Login = lazy(() => import('./pages/Login'))
const Signup = lazy(() => import('./pages/Signup'))
const ActivityLog = lazy(() => import('./pages/ActivityLog'))
const Purchases = lazy(() => import('./pages/Purchases'))
const Nhis = lazy(() => import('./pages/Nhis'))

const RouteFallback = () => (
  <div className="route-fallback" role="status" aria-live="polite">
    <div className="route-fallback-spinner" aria-hidden="true" />
    <div className="route-fallback-copy">
      <strong>Loading workspace</strong>
      <p>Preparing the next screen...</p>
    </div>
  </div>
)

function App() {
  const { canManageInventory, canViewReports, canManageClaims } = useAuth()
  const { canUsePurchases, canUseNhis, canUseAccounting } = useTenant()
  return (
    <Router>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardHome />} />
            <Route
              path="inventory"
              element={
                <RoleRoute allowedRoles={INVENTORY_ROLES} allow={canManageInventory}>
                  <Inventory />
                </RoleRoute>
              }
            />
            <Route
              path="sales"
              element={
                <RoleRoute allowedRoles={SALES_ROLES}>
                  <Sales />
                </RoleRoute>
              }
            />
            <Route
              path="patients"
              element={
                <RoleRoute allowedRoles={PATIENT_ROLES}>
                  <Patients />
                </RoleRoute>
              }
            />
            <Route
              path="claims"
              element={
                <RoleRoute allowedRoles={CLAIMS_ROLES} allow={canManageClaims}>
                  <Claims />
                </RoleRoute>
              }
            />
            <Route
              path="purchases"
              element={
                <RoleRoute allowedRoles={PURCHASES_ROLES} featureAllowed={canUsePurchases}>
                  <Purchases />
                </RoleRoute>
              }
            />
            <Route
              path="nhis"
              element={
                <RoleRoute allowedRoles={NHIS_ROLES} featureAllowed={canUseNhis}>
                  <Nhis />
                </RoleRoute>
              }
            />
            <Route
              path="reports"
              element={
                <RoleRoute allowedRoles={REPORT_ROLES} allow={canViewReports}>
                  <Reports />
                </RoleRoute>
              }
            />
            <Route
              path="accounting"
              element={
                <RoleRoute allowedRoles={ACCOUNTING_ROLES} featureAllowed={canUseAccounting}>
                  <Accounting />
                </RoleRoute>
              }
            />
            <Route
              path="settings"
              element={
                <RoleRoute allowedRoles={SETTINGS_ROLES}>
                  <Settings />
                </RoleRoute>
              }
            />
            <Route
              path="tenant-admin"
              element={
                <RoleRoute allowedRoles={['super_admin']}>
                  <TenantAdmin />
                </RoleRoute>
              }
            />
            <Route
              path="activity-log"
              element={
                <RoleRoute allowedRoles={ACTIVITY_LOG_ROLES}>
                  <ActivityLog />
                </RoleRoute>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </Router>
  )
}

export default App
