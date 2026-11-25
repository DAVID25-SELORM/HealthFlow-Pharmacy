import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const updatesDir = path.join(serverDir, 'updates')
const statusPath = path.join(updatesDir, 'status.json')
const packagePath = path.join(updatesDir, 'pending-update.zip')
const windowsApplyScriptPath = path.join(serverDir, 'scripts', 'apply-update.ps1')
const linuxApplyScriptPath = '/usr/local/lib/healthflow/apply-update-linux.sh'
const packageJson = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'))
let updateTimer = null
let firstCheckTimer = null
let installInFlight = false

const BUSY_STATES = new Set([
  'downloading',
  'installing',
  'stopping_service',
  'backing_up',
  'installing_files',
  'installing_dependencies',
  'restarting',
  'verifying',
])
const FINAL_STATES = new Set(['installed', 'rolled_back', 'failed'])
// An install that has not reported anything for this long is treated as dead, so it cannot block updates for ever.
const BUSY_LIMIT_MS = 30 * 60 * 1000
// After a check that did not work (usually no internet), try again this soon.
export const UPDATE_RETRY_INTERVAL_MS = 15 * 60 * 1000

export const getUpdateInstallerCommand = ({
  platform,
  installDir = serverDir,
  pendingPackagePath = packagePath,
  expectedVersion,
  serviceName = config.updates.serviceName,
  databasePath = config.sqlitePath,
}) => {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        windowsApplyScriptPath,
        '-InstallDir',
        installDir,
        '-PackagePath',
        pendingPackagePath,
        '-ExpectedVersion',
        expectedVersion,
        '-ServiceName',
        serviceName,
        '-DatabasePath',
        databasePath,
      ],
      windowsHide: true,
    }
  }

  if (platform === 'linux') {
    return {
      command: 'sudo',
      args: ['-n', linuxApplyScriptPath, pendingPackagePath, expectedVersion],
      windowsHide: false,
    }
  }

  throw new Error(`Automatic installation is not supported on ${platform}.`)
}

const quoteWindowsArgument = (value) => {
  const text = String(value)
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

// The updater stops this very service. Windows service wrappers end the whole process tree of the service they
// stop, so an updater started as our child could be ended in the middle of an update. Asking Windows (WMI) to
// start it makes it a separate process that is not part of the service.
export const getDetachedWindowsLaunchCommand = (installer) => {
  const commandLine = [installer.command, ...installer.args].map(quoteWindowsArgument).join(' ')
  const escaped = commandLine.replace(/'/g, "''")
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}' }; if ($r.ReturnValue -ne 0) { exit 1 }`,
    ],
    windowsHide: true,
  }
}

const normalizeVersion = (value) => String(value || '').trim().replace(/^v/i, '')
const parseVersion = (value) => {
  const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  return match ? match.slice(1).map(Number) : null
}

export const compareVersions = (left, right) => {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  if (!leftParts || !rightParts) {
    throw new Error('Update versions must use semantic versioning, for example 1.2.3.')
  }

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1
    }
  }
  return 0
}

export const getManifestSigningPayload = (manifest) =>
  [
    normalizeVersion(manifest.version),
    String(manifest.channel || 'stable').trim().toLowerCase(),
    String(manifest.packageUrl || '').trim(),
    String(manifest.sha256 || '').trim().toLowerCase(),
    String(manifest.publishedAt || '').trim(),
  ].join('\n')

export const verifyUpdateManifest = (manifest, publicKey = config.updates.publicKey) => {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('The update manifest is invalid.')
  }

  const required = ['version', 'packageUrl', 'sha256', 'publishedAt', 'signature']
  for (const field of required) {
    if (!String(manifest[field] || '').trim()) {
      throw new Error(`The update manifest is missing ${field}.`)
    }
  }

  if (!/^[a-f0-9]{64}$/i.test(String(manifest.sha256))) {
    throw new Error('The update package SHA-256 is invalid.')
  }

  const packageUrl = new URL(manifest.packageUrl)
  if (packageUrl.protocol !== 'https:') {
    throw new Error('The update package URL must use HTTPS.')
  }

  if (!publicKey) {
    throw new Error('HEALTHFLOW_UPDATE_PUBLIC_KEY is not configured.')
  }

  const verified = crypto.verify(
    null,
    Buffer.from(getManifestSigningPayload(manifest), 'utf8'),
    publicKey,
    Buffer.from(String(manifest.signature), 'base64')
  )
  if (!verified) {
    throw new Error('The update manifest signature is invalid.')
  }
  return true
}

// Windows PowerShell 5.1 (which runs the updater) starts the file it writes with a byte-order mark, and JSON.parse
// rejects it. Without removing it the server could never read whether an update worked or was rolled back.
export const parseStatusText = (text) => JSON.parse(String(text).replace(/^\uFEFF/, ''))

const isNewerVersion = (candidate, current) => {
  try {
    return compareVersions(candidate, current) > 0
  } catch {
    return false
  }
}

export const isUpdateInProgress = (status, now = Date.now()) => {
  if (!BUSY_STATES.has(String(status?.state || '').toLowerCase())) return false
  const updatedAt = Date.parse(status?.updatedAt || '')
  return Number.isFinite(updatedAt) && now - updatedAt < BUSY_LIMIT_MS
}

export const isCheckDue = (status, now, autoCheckHours) => {
  if (!(autoCheckHours > 0) || isUpdateInProgress(status, now)) return false
  if (status?.lastCheckError) return true
  const lastCheckedAt = Date.parse(status?.lastCheckedAt || '')
  if (!Number.isFinite(lastCheckedAt)) return true
  return now - lastCheckedAt >= autoCheckHours * 60 * 60 * 1000
}

// The result of the last install is kept apart, so a later check does not erase "the old version was restored".
const getLastInstall = (status) =>
  FINAL_STATES.has(String(status?.state || '').toLowerCase())
    ? {
        state: status.state,
        version: status.latestVersion || '',
        message: status.message || '',
        at: status.updatedAt || null,
      }
    : status?.lastInstall || null

export const describeUpdateError = (error) => {
  const detail = `${error?.message || ''} ${error?.cause?.code || ''}`
  if (
    error?.name === 'AbortError' ||
    /fetch failed|aborted|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT/i.test(detail)
  ) {
    return 'Could not reach the HealthFlow update service. Check the internet connection.'
  }
  return error?.message || 'The update check did not work.'
}

export const buildCheckSuccess = (previous, manifest, currentVersion, now = new Date()) => {
  const latestVersion = normalizeVersion(manifest.version)
  const available = compareVersions(latestVersion, currentVersion) > 0
  return {
    state: available ? 'available' : 'current',
    message: available ? `HealthFlow ${latestVersion} is available.` : 'This branch server is up to date.',
    latestVersion,
    releaseNotes: String(manifest.releaseNotes || ''),
    publishedAt: manifest.publishedAt,
    lastCheckedAt: now.toISOString(),
    lastCheckError: '',
    lastInstall: getLastInstall(previous),
  }
}

// A failed check keeps what is already known: an update found earlier is still there when the internet drops.
export const buildCheckFailure = (previous, error, currentVersion) => {
  const reason = describeUpdateError(error)
  const stillAvailable = isNewerVersion(previous?.latestVersion, currentVersion)
  return {
    ...previous,
    state: stillAvailable ? 'available' : 'check_failed',
    message: stillAvailable ? `HealthFlow ${previous.latestVersion} is available.` : reason,
    lastCheckError: reason,
    lastInstall: getLastInstall(previous),
  }
}

const ensureUpdatesDir = () => fs.mkdirSync(updatesDir, { recursive: true })

const readStatus = () => {
  try {
    return parseStatusText(fs.readFileSync(statusPath, 'utf8'))
  } catch {
    return {
      state: 'idle',
      message: 'No update has been installed from this branch server.',
      updatedAt: null,
    }
  }
}

const writeStatus = (status) => {
  ensureUpdatesDir()
  const nextStatus = {
    ...status,
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(statusPath, JSON.stringify(nextStatus, null, 2), 'utf8')
  return nextStatus
}

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.updates.checkTimeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const fetchManifest = async () => {
  if (!config.updates.manifestUrl) {
    throw new Error('HEALTHFLOW_UPDATE_MANIFEST_URL is not configured.')
  }

  const manifestUrl = new URL(config.updates.manifestUrl)
  if (manifestUrl.protocol !== 'https:') {
    throw new Error('HEALTHFLOW_UPDATE_MANIFEST_URL must use HTTPS.')
  }

  const response = await fetchWithTimeout(manifestUrl, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  })
  if (!response.ok) {
    throw new Error(`Update manifest request failed with HTTP ${response.status}.`)
  }

  const manifest = await response.json()
  verifyUpdateManifest(manifest)
  if (String(manifest.channel || 'stable').toLowerCase() !== config.updates.channel) {
    throw new Error(`The update manifest is for the ${manifest.channel} channel.`)
  }
  return manifest
}

export const getUpdateStatus = () => {
  const currentVersion = normalizeVersion(packageJson.version)
  const status = readStatus()
  return {
    configured: Boolean(config.updates.manifestUrl && config.updates.publicKey),
    currentVersion,
    platform: process.platform,
    installerSupported: ['win32', 'linux'].includes(process.platform),
    installerReady:
      process.platform === 'win32'
        ? fs.existsSync(windowsApplyScriptPath)
        : process.platform === 'linux'
          ? fs.existsSync(linuxApplyScriptPath)
          : false,
    channel: config.updates.channel,
    autoCheckHours: config.updates.autoCheckHours,
    autoInstall: config.updates.autoInstall,
    ...status,
    // Worked out from the versions every time, so it is still right after the screen or the server restarts.
    available: isNewerVersion(status.latestVersion, currentVersion),
    inProgress: isUpdateInProgress(status),
  }
}

// What every signed-in member of staff may know: whether there is an update. No server details.
export const getUpdateNotice = (status = getUpdateStatus()) => ({
  currentVersion: status.currentVersion,
  latestVersion: status.available ? status.latestVersion : '',
  releaseNotes: status.available ? String(status.releaseNotes || '') : '',
  available: Boolean(status.available),
  inProgress: Boolean(status.inProgress),
})

export const getUpdateTerminalState = (status = readStatus()) =>
  FINAL_STATES.has(String(status.state || '').toLowerCase())

export const checkForUpdates = async () => {
  // A check must not write over the progress of an install that is running.
  if (isUpdateInProgress(readStatus())) return getUpdateStatus()

  let manifest
  try {
    manifest = await fetchManifest()
  } catch (error) {
    if (!isUpdateInProgress(readStatus())) {
      writeStatus(buildCheckFailure(readStatus(), error, packageJson.version))
    }
    throw new Error(describeUpdateError(error), { cause: error })
  }

  if (!isUpdateInProgress(readStatus())) {
    writeStatus(buildCheckSuccess(readStatus(), manifest, packageJson.version))
  }
  return getUpdateStatus()
}

const downloadPackage = async (manifest) => {
  const response = await fetchWithTimeout(manifest.packageUrl)
  if (!response.ok) {
    throw new Error(`Update package request failed with HTTP ${response.status}.`)
  }

  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > config.updates.maxPackageBytes) {
    throw new Error('The update package exceeds the configured size limit.')
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > config.updates.maxPackageBytes) {
    throw new Error('The update package exceeds the configured size limit.')
  }

  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(String(manifest.sha256).toLowerCase()))) {
    throw new Error('The downloaded update package failed SHA-256 verification.')
  }

  ensureUpdatesDir()
  fs.writeFileSync(packagePath, bytes)
}

export const installAvailableUpdate = async () => {
  if (!['win32', 'linux'].includes(process.platform)) {
    throw new Error(`Automatic installation is not supported on ${process.platform}.`)
  }
  if (process.platform === 'linux' && !fs.existsSync(linuxApplyScriptPath)) {
    throw new Error('Linux update helper is not installed. Rerun install-linux-service.sh once.')
  }

  if (installInFlight || isUpdateInProgress(readStatus())) {
    throw new Error('An update is already being installed.')
  }
  installInFlight = true
  try {
    return await startInstall()
  } finally {
    installInFlight = false
  }
}

const startInstall = async () => {
  let manifest
  try {
    manifest = await fetchManifest()
  } catch (error) {
    writeStatus(buildCheckFailure(readStatus(), error, packageJson.version))
    throw new Error(describeUpdateError(error), { cause: error })
  }

  const checked = buildCheckSuccess(readStatus(), manifest, packageJson.version)
  if (compareVersions(manifest.version, packageJson.version) <= 0) {
    writeStatus(checked)
    return getUpdateStatus()
  }

  writeStatus({
    ...checked,
    state: 'downloading',
    message: `Downloading HealthFlow ${normalizeVersion(manifest.version)}...`,
  })

  try {
    try {
      await downloadPackage(manifest)
    } catch (error) {
      throw new Error(`${describeUpdateError(error)} Nothing was changed.`, { cause: error })
    }
    writeStatus({
      ...checked,
      state: 'installing',
      message: `Installing HealthFlow ${normalizeVersion(manifest.version)}. The local server will restart.`,
      latestVersion: normalizeVersion(manifest.version),
    })

    const installer = getUpdateInstallerCommand({
      platform: process.platform,
      expectedVersion: normalizeVersion(manifest.version),
      databasePath: config.sqlitePath,
    })
    // On Windows the launcher is short-lived (it only asks WMI to start the updater, which is a separate process
    // from then on); a detached launcher does not manage to start it, so it is not detached.
    const viaWmi = process.platform === 'win32'
    const launch = viaWmi ? getDetachedWindowsLaunchCommand(installer) : installer
    const child = spawn(launch.command, launch.args, {
      detached: !viaWmi,
      stdio: 'ignore',
      windowsHide: launch.windowsHide,
    })
    child.once('error', (error) => {
      writeStatus({
        state: 'failed',
        message: `Unable to start the update installer: ${error.message}`,
        latestVersion: normalizeVersion(manifest.version),
      })
    })
    child.once('exit', (code) => {
      if (code && code !== 0) {
        writeStatus({
          state: 'failed',
          message: `The update installer exited with code ${code}.`,
          latestVersion: normalizeVersion(manifest.version),
        })
      }
    })
    child.unref()

    return {
      ...getUpdateStatus(),
      restartRequired: true,
    }
  } catch (error) {
    writeStatus({
      ...checked,
      state: 'failed',
      message: error.message || 'Update installation failed.',
    })
    throw error
  }
}

export const startUpdateScheduler = () => {
  if (
    updateTimer ||
    !config.updates.manifestUrl ||
    !config.updates.publicKey ||
    config.updates.autoCheckHours <= 0
  ) {
    return
  }

  const runScheduledCheck = async () => {
    try {
      const result = await checkForUpdates()
      // A version that already failed here is left for a person to retry, not installed again by itself.
      const failedBefore =
        ['rolled_back', 'failed'].includes(result.lastInstall?.state) &&
        result.lastInstall?.version === result.latestVersion
      if (result.available && !result.inProgress && !failedBefore && config.updates.autoInstall) {
        await installAvailableUpdate()
      }
    } catch (error) {
      // checkForUpdates and installAvailableUpdate have already saved what went wrong.
      console.warn(`Scheduled update check did not work: ${error.message}`)
    }
  }

  // The timer ticks often, but only checks when one is due: soon after a failed check (so an update is found shortly
  // after the internet returns), otherwise every autoCheckHours.
  updateTimer = setInterval(
    () => {
      if (isCheckDue(readStatus(), Date.now(), config.updates.autoCheckHours)) void runScheduledCheck()
    },
    Math.min(UPDATE_RETRY_INTERVAL_MS, config.updates.autoCheckHours * 60 * 60 * 1000)
  )
  updateTimer.unref()
  firstCheckTimer = setTimeout(() => void runScheduledCheck(), 60000)
  firstCheckTimer.unref()
}

export const stopUpdateScheduler = () => {
  if (updateTimer) {
    clearInterval(updateTimer)
    updateTimer = null
  }
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer)
    firstCheckTimer = null
  }
}
