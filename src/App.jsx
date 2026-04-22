import { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/Auth/ProtectedRoute'
import RoleRoute from './components/Auth/RoleRoute'
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
                <RoleRoute allowedRoles={['admin', 'pharmacist']}>
                  <Inventory />
                </RoleRoute>
              }
            />
            <Route
              path="sales"
              element={
                <RoleRoute allowedRoles={['admin', 'pharmacist', 'assistant']}>
                  <Sales />
                </RoleRoute>
              }
            />
            <Route
              path="patients"
              element={
                <RoleRoute allowedRoles={['admin', 'pharmacist', 'assistant']}>
                  <Patients />
                </RoleRoute>
              }
            />
            <Route
              path="claims"
              element={
                <RoleRoute allowedRoles={['admin', 'pharmacist']}>
                  <Claims />
                </RoleRoute>
              }
            />
            <Route
              path="reports"
              element={
                <RoleRoute allowedRoles={['admin', 'pharmacist']}>
                  <Reports />
                </RoleRoute>
              }
            />
            <Route
              path="accounting"
              element={
                <RoleRoute allowedRoles={['admin']}>
                  <Accounting />
                </RoleRoute>
              }
            />
            <Route
              path="settings"
              element={
                <RoleRoute allowedRoles={['admin']}>
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
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </Router>
  )
}

export default App
