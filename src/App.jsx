import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout/Layout'
import ProtectedRoute from './components/Auth/ProtectedRoute'
import RoleRoute from './components/Auth/RoleRoute'
import DashboardHome from './pages/DashboardHome'
import Inventory from './pages/Inventory'
import Sales from './pages/Sales'
import Patients from './pages/Patients'
import Claims from './pages/Claims'
import Reports from './pages/Reports'
import Accounting from './pages/Accounting'
import Settings from './pages/Settings'
import TenantAdmin from './pages/TenantAdmin'
import Login from './pages/Login'
import Signup from './pages/Signup'
import './App.css'

function App() {
  return (
    <Router>
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
    </Router>
  )
}

export default App
