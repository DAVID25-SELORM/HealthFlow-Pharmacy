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

const ensureUpdatesDir = () => fs.mkdirSync(updatesDir, { recursive: true })

const readStatus = () => {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'))
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

export const getUpdateStatus = () => ({
  configured: Boolean(config.updates.manifestUrl && config.updates.publicKey),
  currentVersion: normalizeVersion(packageJson.version),
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
  ...readStatus(),
})

export const getUpdateTerminalState = (status = readStatus()) =>
  ['installed', 'rolled_back', 'failed'].includes(String(status.state || '').toLowerCase())

export const checkForUpdates = async () => {
  const manifest = await fetchManifest()
  const available = compareVersions(manifest.version, packageJson.version) > 0
  const status = writeStatus({
    state: available ? 'available' : 'current',
    message: available
      ? `HealthFlow ${normalizeVersion(manifest.version)} is available.`
      : 'This branch server is up to date.',
    latestVersion: normalizeVersion(manifest.version),
    releaseNotes: String(manifest.releaseNotes || ''),
    publishedAt: manifest.publishedAt,
  })
  return {
    ...getUpdateStatus(),
    ...status,
    available,
  }
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

  const manifest = await fetchManifest()
  if (compareVersions(manifest.version, packageJson.version) <= 0) {
    return writeStatus({
      state: 'current',
      message: 'This branch server is already up to date.',
      latestVersion: normalizeVersion(manifest.version),
    })
  }

  writeStatus({
    state: 'downloading',
    message: `Downloading HealthFlow ${normalizeVersion(manifest.version)}...`,
    latestVersion: normalizeVersion(manifest.version),
  })

  try {
    await downloadPackage(manifest)
    writeStatus({
      state: 'installing',
      message: `Installing HealthFlow ${normalizeVersion(manifest.version)}. The local server will restart.`,
      latestVersion: normalizeVersion(manifest.version),
    })

    const installer = getUpdateInstallerCommand({
      platform: process.platform,
      expectedVersion: normalizeVersion(manifest.version),
      databasePath: config.sqlitePath,
    })
    const child = spawn(installer.command, installer.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: installer.windowsHide,
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
      state: 'failed',
      message: error.message || 'Update installation failed.',
      latestVersion: normalizeVersion(manifest.version),
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
      if (result.available && config.updates.autoInstall) {
        await installAvailableUpdate()
      }
    } catch (error) {
      writeStatus({
        state: 'check_failed',
        message: error.message || 'Scheduled update check failed.',
      })
    }
  }

  updateTimer = setInterval(
    () => void runScheduledCheck(),
    config.updates.autoCheckHours * 60 * 60 * 1000
  )
  updateTimer.unref()
  setTimeout(() => void runScheduledCheck(), 60000).unref()
}

export const stopUpdateScheduler = () => {
  if (updateTimer) {
    clearInterval(updateTimer)
    updateTimer = null
  }
}
