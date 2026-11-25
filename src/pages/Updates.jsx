import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBranchUpdateNotice } from '../hooks/useBranchUpdateNotice'
import { refreshBranchUpdateNotice } from '../services/branchUpdateNotice'
import {
  checkBranchServerUpdates,
  getBranchUpdateStatus,
  installBranchServerUpdate,
  isServedByOfflineServer,
  waitForBranchUpdateCompletion,
} from '../services/branchServerApi'
import { requestAppConfirmation } from '../utils/appDialog'
import './Updates.css'

// The states the server and the Windows updater report, grouped into the steps a person can follow.
const STEPS = [
  { label: 'Downloading the update', states: ['downloading', 'installing'] },
  { label: 'Backing up the app and your data', states: ['stopping_service', 'backing_up'] },
  { label: 'Installing the new version', states: ['installing_files', 'installing_dependencies'] },
  { label: 'Restarting and checking HealthFlow', states: ['restarting', 'verifying'] },
]
const FINAL_STATES = ['installed', 'rolled_back', 'failed']

const formatWhen = (value) => {
  const date = new Date(value || '')
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

const getLastInstall = (status) =>
  FINAL_STATES.includes(status?.state)
    ? { state: status.state, version: status.latestVersion, message: status.message }
    : status?.lastInstall || null

export default function Updates() {
  const { role } = useAuth()
  const isAdmin = ['admin', 'super_admin'].includes(String(role || '').toLowerCase())
  const offline = isServedByOfflineServer()
  const notice = useBranchUpdateNotice()
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState('')
  const [outcome, setOutcome] = useState(null)
  const [problem, setProblem] = useState('')
  const watching = useRef(false)

  // Follows a running install to its end. The server restarts part-way, so failed requests are expected.
  const watchInstall = useCallback(async (expectedVersion) => {
    if (watching.current) return
    watching.current = true
    setBusy('install')
    let lastSeen = null
    try {
      const finished = await waitForBranchUpdateCompletion({
        expectedVersion,
        onStatus: (next) => {
          lastSeen = next
          setStatus(next)
        },
      })
      setOutcome({ type: 'success', version: finished.currentVersion })
    } catch (error) {
      setOutcome({
        type: lastSeen?.state === 'rolled_back' ? 'restored' : 'problem',
        message: error.message,
      })
    } finally {
      watching.current = false
      setBusy('')
      void refreshBranchUpdateNotice()
    }
  }, [])

  useEffect(() => {
    if (!offline || !isAdmin) return undefined
    let cancelled = false
    getBranchUpdateStatus()
      .then((next) => {
        if (cancelled) return
        setStatus(next)
        // The page was opened, or reloaded, while an install was already running.
        if (next.inProgress) void watchInstall(next.latestVersion)
      })
      .catch((error) => {
        if (!cancelled) setProblem(error.message)
      })
    return () => {
      cancelled = true
    }
  }, [isAdmin, offline, watchInstall, notice?.latestVersion, notice?.currentVersion])

  const checkNow = async () => {
    setBusy('check')
    setProblem('')
    setOutcome(null)
    try {
      setStatus(await checkBranchServerUpdates())
    } catch (error) {
      setProblem(error.message || 'The update check did not work.')
      setStatus(await getBranchUpdateStatus().catch(() => status))
    } finally {
      setBusy('')
      void refreshBranchUpdateNotice()
    }
  }

  const updateNow = async () => {
    const confirmed = await requestAppConfirmation({
      title: 'Update HealthFlow now?',
      warning:
        'HealthFlow will restart and pause for a few minutes for everyone using this offline server. Finish open sales first and choose a quiet time.',
      confirmText: 'Update HealthFlow now',
    })
    if (!confirmed) return

    const expectedVersion = status?.latestVersion || notice?.latestVersion || ''
    setBusy('install')
    setProblem('')
    setOutcome(null)
    try {
      const started = await installBranchServerUpdate()
      setStatus(started)
      if (!started.restartRequired) {
        setBusy('')
        return
      }
    } catch (error) {
      // A slow download can outlast this request while the server carries on, so ask what it is doing.
      const current = await getBranchUpdateStatus().catch(() => null)
      if (!current?.inProgress) {
        if (current) setStatus(current)
        setProblem(error.message || 'The update could not be started.')
        setBusy('')
        return
      }
    }
    await watchInstall(expectedVersion)
  }

  if (!offline) {
    return (
      <div className="updates-page">
        <h1>Updates</h1>
        <p>This page is for the offline version of HealthFlow. The online version updates by itself.</p>
      </div>
    )
  }

  const currentVersion = status?.currentVersion || notice?.currentVersion || ''
  const available = isAdmin && status ? Boolean(status.available) : Boolean(notice?.available)
  const latestVersion = available ? status?.latestVersion || notice?.latestVersion : ''
  const releaseNotes = available ? status?.releaseNotes || notice?.releaseNotes : ''
  const installing = busy === 'install' || Boolean(status?.inProgress || notice?.inProgress)
  const activeStep = STEPS.findIndex((step) => step.states.includes(status?.state))
  const lastInstall = getLastInstall(status)
  const checkedAt = formatWhen(status?.lastCheckedAt)
  const cannotInstall = status?.installerSupported === false || status?.installerReady === false

  let headline = 'Checking this offline server…'
  if (installing) headline = 'HealthFlow is being updated'
  else if (available) headline = 'A new version is ready'
  else if (isAdmin && status?.configured === false) headline = 'Updates are not set up on this offline server'
  // Right after an install the updater's status has no check time yet; that is not "never checked".
  else if (isAdmin && status && !checkedAt && !['current', ...FINAL_STATES].includes(status.state)) {
    headline = 'No update check has worked yet'
  }
  else if ((isAdmin && status) || (!isAdmin && notice)) headline = 'No update is waiting'

  return (
    <div className="updates-page">
      <header>
        <h1>Updates</h1>
        <p>New versions of the offline HealthFlow. Nothing is installed until an administrator chooses to.</p>
      </header>

      {outcome?.type === 'success' && (
        <div className="updates-message success" role="status">
          <strong>HealthFlow was updated to version {outcome.version}.</strong>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload HealthFlow</button>
        </div>
      )}
      {outcome?.type === 'restored' && (
        <div className="updates-message warning" role="alert">
          <strong>The update did not work. Your previous version was restored.</strong>
          <p>{outcome.message}</p>
        </div>
      )}
      {outcome?.type === 'problem' && (
        <div className="updates-message danger" role="alert">
          <strong>The update did not finish.</strong>
          <p>{outcome.message}</p>
          <p>If HealthFlow does not work normally, contact support before trying again.</p>
        </div>
      )}
      {problem && <div className="updates-message warning" role="alert"><p>{problem}</p></div>}

      <section className="updates-card" aria-live="polite">
        <h2>{headline}</h2>
        <dl>
          <div>
            <dt>Installed version</dt>
            <dd>{currentVersion || '—'}</dd>
          </div>
          {latestVersion && (
            <div>
              <dt>New version</dt>
              <dd>{latestVersion}</dd>
            </div>
          )}
        </dl>

        {releaseNotes && (
          <div className="updates-notes">
            <h3>What has changed</h3>
            <p>{releaseNotes}</p>
          </div>
        )}

        {installing ? (
          <>
            <ol className="updates-steps">
              {STEPS.map((step, index) => (
                <li
                  key={step.label}
                  className={index < activeStep ? 'done' : index === activeStep ? 'current' : ''}
                  aria-current={index === activeStep ? 'step' : undefined}
                >
                  {step.label}
                </li>
              ))}
            </ol>
            <p>Keep the offline server computer switched on. This page reconnects by itself after the restart.</p>
          </>
        ) : (
          <>
            {isAdmin ? (
              <div className="updates-actions">
                {available && (
                  <button type="button" className="btn btn-primary" onClick={() => void updateNow()} disabled={Boolean(busy) || cannotInstall}>
                    Update now
                  </button>
                )}
                <button type="button" className="btn btn-outline" onClick={() => void checkNow()} disabled={Boolean(busy) || status?.configured === false}>
                  {busy === 'check' ? 'Checking…' : 'Check now'}
                </button>
              </div>
            ) : (
              available && <p className="updates-ask">Ask your administrator to update HealthFlow.</p>
            )}
            {isAdmin && available && cannotInstall && <p>This computer cannot install updates by itself. Contact support.</p>}
          </>
        )}

        {isAdmin && checkedAt && <p className="updates-muted">Last successful check: {checkedAt}</p>}
        {isAdmin && !installing && status?.lastCheckError && (
          <p className="updates-muted">The latest check did not work: {status.lastCheckError} HealthFlow will try again by itself.</p>
        )}
        {isAdmin && !installing && !outcome && lastInstall && ['rolled_back', 'failed'].includes(lastInstall.state) &&
          lastInstall.version !== currentVersion && (
            <p className="updates-muted">
              {lastInstall.state === 'rolled_back'
                ? `The last update to ${lastInstall.version} did not work, and the previous version was restored.`
                : `The last update to ${lastInstall.version} did not finish.`} {lastInstall.message}
            </p>
        )}
      </section>
    </div>
  )
}
