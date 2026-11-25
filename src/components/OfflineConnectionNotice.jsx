import { getBranchServerConfig, isServedByOfflineServer } from '../services/branchServerApi'
import './OfflineConnectionNotice.css'

// Shown when the page came from an offline server but this browser is not registered with it, so offline sign-in,
// offline work and updates cannot be used here. Without this it would fail without saying why.
const OfflineConnectionNotice = () => {
  if (!isServedByOfflineServer() || getBranchServerConfig().authorized) return null

  return (
    <div className="offline-connection-notice" role="alert">
      <strong>This browser is not connected to the offline server.</strong>
      <span>
        On this computer, open HealthFlow from the “HealthFlow Offline POS” desktop shortcut. On a new computer, ask
        your administrator for the “Connect This Computer” package.
      </span>
    </div>
  )
}

export default OfflineConnectionNotice
