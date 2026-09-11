import { useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { startFacilityContactReporting } from '../services/facilityConnectivityService'

export default function FacilityContactReporter() {
  const { session, user, organization, role, loading } = useAuth()
  const enabled = !loading && Boolean(session?.access_token && user?.id && organization?.id)
    && !session?.offline && role !== 'super_admin'
  useEffect(() => {
    if (!enabled) return undefined
    return startFacilityContactReporting()
  }, [enabled, user?.id, organization?.id])
  return null
}
