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
  EPHARMACY_ROLES,
  INVENTORY_ROLES,
  NHIS_ROLES,
  OFFLINE_SYNC_ROLES,
  PATIENT_CARE_ROLES,
  PATIENT_ROLES,
  REPORT_ROLES,
  SALES_ROLES,
  SETTINGS_ROLES,
  SYSTEM_HEALTH_ROLES,
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
const Terms = lazy(() => import('./pages/Terms'))
const ActivityLog = lazy(() => import('./pages/ActivityLog'))
const SystemHealth = lazy(() => import('./pages/SystemHealth'))
const Diagnostics = lazy(() => import('./pages/Diagnostics'))
const OfflineInstallerReleases = lazy(() => import('./pages/OfflineInstallerReleases'))
const OfflineSync = lazy(() => import('./pages/OfflineSync'))
const Support = lazy(() => import('./pages/Support'))
const Purchases = lazy(() => import('./pages/Purchases'))
const Nhis = lazy(() => import('./pages/Nhis'))
const EPharmacy = lazy(() => import('./pages/EPharmacy'))
const PatientCare = lazy(() => import('./pages/PatientCare'))
const CustomerEPharmacy = lazy(() => import('./pages/CustomerEPharmacy'))
const RecycleBin = lazy(() => import('./pages/RecycleBin'))
const RestrictedInventory = lazy(() => import('./pages/RestrictedInventory'))

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
  const {
    canManageInventory,
    canViewReports,
    canManageClaims,
    canManagePurchases,
    canProcessSales,
    canManagePatients,
    canManageAccounting,
    canManageEpharmacy,
    canViewActivityLog,
    canManageRestrictedInventory,
  } = useAuth()
  const { canUseClaims, canUsePurchases, canUseNhis, canUseAccounting } = useTenant()
  return (
    <Router>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/shop" element={<CustomerEPharmacy />} />
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
                <RoleRoute allowedRoles={SALES_ROLES} allow={canProcessSales}>
                  <Sales />
                </RoleRoute>
              }
            />
            <Route
              path="patients"
              element={
                <RoleRoute allowedRoles={PATIENT_ROLES} allow={canManagePatients}>
                  <Patients />
                </RoleRoute>
              }
            />
            <Route
              path="claims"
              element={
                <RoleRoute allowedRoles={CLAIMS_ROLES} allow={canManageClaims} featureAllowed={canUseClaims}>
                  <Claims />
                </RoleRoute>
              }
            />
            <Route
              path="purchases"
              element={
                <RoleRoute
                  allowedRoles={['admin', 'super_admin']}
                  allow={canManagePurchases}
                  featureAllowed={canUsePurchases}
                >
                  <Purchases />
                </RoleRoute>
              }
            />
            <Route
              path="e-pharmacy"
              element={
                <RoleRoute allowedRoles={EPHARMACY_ROLES} allow={canManageEpharmacy}>
                  <EPharmacy />
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
              path="patient-care"
              element={
                <RoleRoute allowedRoles={PATIENT_CARE_ROLES} allow={canManagePatients}>
                  <PatientCare />
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
                <RoleRoute allowedRoles={ACCOUNTING_ROLES} allow={canManageAccounting} featureAllowed={canUseAccounting}>
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
                <RoleRoute allowedRoles={ACTIVITY_LOG_ROLES} allow={canViewActivityLog}>
                  <ActivityLog />
                </RoleRoute>
              }
            />
            <Route
              path="recycle-bin"
              element={
                <RoleRoute allowedRoles={['admin', 'super_admin']}>
                  <RecycleBin />
                </RoleRoute>
              }
            />
            <Route
              path="restricted-inventory"
              element={
                <RoleRoute
                  allowedRoles={['super_admin', 'compliance_admin', 'compliance_officer']}
                  allow={canManageRestrictedInventory}
                >
                  <RestrictedInventory />
                </RoleRoute>
              }
            />
            <Route
              path="system-health"
              element={
                <RoleRoute allowedRoles={SYSTEM_HEALTH_ROLES}>
                  <SystemHealth />
                </RoleRoute>
              }
            />
            <Route
              path="diagnostics"
              element={
                <RoleRoute allowedRoles={['super_admin']}>
                  <Diagnostics />
                </RoleRoute>
              }
            />
            <Route
              path="offline-installer-releases"
              element={
                <RoleRoute allowedRoles={['super_admin']}>
                  <OfflineInstallerReleases />
                </RoleRoute>
              }
            />
            <Route
              path="offline-sync"
              element={
                <RoleRoute allowedRoles={OFFLINE_SYNC_ROLES}>
                  <OfflineSync />
                </RoleRoute>
              }
            />
            <Route path="support" element={<Support />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </Router>
  )
}

export default App
