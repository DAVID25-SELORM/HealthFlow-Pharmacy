import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowUpFromLine } from 'lucide-react'
import { useBranchUpdateNotice } from '../hooks/useBranchUpdateNotice'
import './BranchUpdateBanner.css'

const DISMISSED_KEY = 'healthflow.update.dismissed'

const readDismissed = () => {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) || ''
  } catch {
    return ''
  }
}

// The notification for an offline server: an update is waiting, being installed, or has been installed.
const BranchUpdateBanner = () => {
  const notice = useBranchUpdateNotice()
  const { pathname } = useLocation()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (!notice || pathname === '/updates') return null

  const hideForNow = () => {
    setDismissed(notice.latestVersion)
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, notice.latestVersion)
    } catch {
      // It stays hidden until the page is reloaded.
    }
  }

  let content = null
  if (notice.reloadNeeded) {
    content = (
      <>
        <span>HealthFlow on this offline server was updated. Finish what you are typing, then reload.</span>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </>
    )
  } else if (notice.inProgress) {
    content = <span>HealthFlow is being updated. It will pause for a few minutes.</span>
  } else if (notice.available && dismissed !== notice.latestVersion) {
    content = (
      <>
        <span>A new HealthFlow version ({notice.latestVersion}) is ready.</span>
        <Link className="btn btn-primary" to="/updates">Open Updates</Link>
        <button type="button" className="btn btn-outline" onClick={hideForNow}>Later</button>
      </>
    )
  }

  if (!content) return null

  return (
    <div className="branch-update-banner" role="status">
      <ArrowUpFromLine size={20} aria-hidden="true" />
      {content}
    </div>
  )
}

export default BranchUpdateBanner
