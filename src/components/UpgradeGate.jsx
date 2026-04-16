import { Lock } from 'lucide-react'
import './UpgradeGate.css'

/**
 * UpgradeGate
 * Renders a locked overlay when a feature is not available on the current tier.
 *
 * Props:
 *   feature: short name of the locked feature, e.g. "Reports"
 *   requiredTier: "pro" | "enterprise"
 *   children: the content to show when unlocked
 *   locked: boolean; when true the overlay is shown
 */
const UpgradeGate = ({ locked, feature, requiredTier = 'pro', children }) => {
  if (!locked) return children

  const tierLabel = requiredTier === 'enterprise' ? 'Enterprise' : 'Professional or Enterprise'

  return (
    <div className="upgrade-gate-wrap">
      <div className="upgrade-gate-blur">{children}</div>
      <div className="upgrade-gate-overlay">
        <div className="upgrade-gate-box">
          <div className="upgrade-gate-icon">
            <Lock size={28} />
          </div>
          <h3>{feature} is locked</h3>
          <p>
            This feature requires the <strong>{tierLabel}</strong> plan. Contact your
            platform admin to upgrade.
          </p>
          <span className="upgrade-gate-badge">Upgrade Required</span>
        </div>
      </div>
    </div>
  )
}

export default UpgradeGate
