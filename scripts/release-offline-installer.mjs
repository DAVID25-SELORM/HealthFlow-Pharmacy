#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const INSTALLER_PREFIX = 'HealthFlow-Offline-Installer'
export const INSTALLER_FALLBACK_URL = 'https://healthflowcloud.com/downloads/HealthFlow-Installer.zip'

const SECRET_NAME_PATTERN = /secret|token|key|password|credential|service_role/i
const PLACEHOLDER_URL_PATTERN = /example\.com|placeholder|your[-_.]?domain|your[-_.]?cdn/i
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

export class InstallerReleaseError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'InstallerReleaseError'
    this.code = code
    this.details = details
  }
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = Number(bytes)
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`
}

export function redactEnvSnapshot(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      SECRET_NAME_PATTERN.test(key) ? '[redacted]' : value,
    ])
  )
}

export function validateInstallerUrl(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (!value) {
    throw new InstallerReleaseError('INSTALLER_URL_MISSING', 'No installer URL was provided.')
  }
  if (value === INSTALLER_FALLBACK_URL || PLACEHOLDER_URL_PATTERN.test(value)) {
    throw new InstallerReleaseError(
      'INSTALLER_URL_PLACEHOLDER',
      'Installer URL is a placeholder, not a published release URL.'
    )
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new InstallerReleaseError('INSTALLER_URL_INVALID', 'Installer URL is not a valid URL.')
  }

  if (parsed.protocol !== 'https:') {
    throw new InstallerReleaseError('INSTALLER_URL_INSECURE', 'Installer URL must use HTTPS.')
  }
  if (parsed.username || parsed.password) {
    throw new InstallerReleaseError(
      'INSTALLER_URL_CREDENTIALS',
      'Installer URL must not contain embedded credentials.'
    )
  }
  if (LOCAL_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.local')) {
    throw new InstallerReleaseError(
      'INSTALLER_URL_LOCAL',
      'Installer URL must point to a public HTTPS host, not a local address.'
    )
  }
  if (!parsed.pathname.endsWith('.zip')) {
    throw new InstallerReleaseError('INSTALLER_URL_EXTENSION', 'Installer URL must point to a ZIP file.')
  }

  const fileName = path.posix.basename(parsed.pathname)
  if (!fileName.startsWith(`${INSTALLER_PREFIX}-`)) {
    throw new InstallerReleaseError(
      'INSTALLER_URL_NAME',
      `Installer ZIP must be named ${INSTALLER_PREFIX}-<version>.zip.`
    )
  }

  return parsed.href
}

export async function readInstallerVersion(serverPackagePath) {
  const contents = await fs.readFile(serverPackagePath, 'utf8')
  const packageJson = JSON.parse(contents)
  if (!packageJson.version) {
    throw new InstallerReleaseError(
      'VERSION_MISSING',
      `No version field found in ${serverPackagePath}.`
    )
  }
  return packageJson.version
}

async function readPackageVersion(packagePath) {
  try {
    const contents = await fs.readFile(packagePath, 'utf8')
    return JSON.parse(contents)?.version || null
  } catch {
    return null
  }
}

async function readGitValue(repoRoot, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoRoot, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      resolve(String(stdout || '').trim() || null)
    })
  })
}

export async function getGitMetadata(repoRoot) {
  const [commit, branch] = await Promise.all([
    readGitValue(repoRoot, ['rev-parse', 'HEAD']),
    readGitValue(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  return {
    git_commit: commit,
    git_branch: branch,
  }
}

export async function calculateSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function findInstallerZip(installersDir, version) {
  let entries
  try {
    entries = await fs.readdir(installersDir, { withFileTypes: true })
  } catch (error) {
    throw new InstallerReleaseError(
      'INSTALLER_DIR_MISSING',
      `Installer output folder does not exist: ${installersDir}`,
      { cause: error }
    )
  }

  const expectedName = `${INSTALLER_PREFIX}-${version}.zip`
  const zipEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
  const exact = zipEntries.find((entry) => entry.name === expectedName)
  if (exact) return path.join(installersDir, exact.name)

  const matchingVersion = zipEntries.filter((entry) =>
    entry.name.startsWith(`${INSTALLER_PREFIX}-${version}`)
  )
  if (matchingVersion.length === 1) return path.join(installersDir, matchingVersion[0].name)
  if (matchingVersion.length > 1) {
    throw new InstallerReleaseError(
      'DUPLICATE_INSTALLER_VERSION',
      `More than one installer ZIP exists for version ${version}.`,
      { files: matchingVersion.map((entry) => entry.name) }
    )
  }

  throw new InstallerReleaseError(
    'ZIP_NOT_FOUND',
    `No ${expectedName} ZIP was found in ${installersDir}.`
  )
}

export async function ensureVersionedInstallerName(zipPath, installersDir, version) {
  const expectedPath = path.join(installersDir, `${INSTALLER_PREFIX}-${version}.zip`)
  if (path.resolve(zipPath) === path.resolve(expectedPath)) return expectedPath

  try {
    await fs.access(expectedPath)
    throw new InstallerReleaseError(
      'DUPLICATE_INSTALLER_VERSION',
      `Cannot rename ${path.basename(zipPath)} because ${path.basename(expectedPath)} already exists.`
    )
  } catch (error) {
    if (error instanceof InstallerReleaseError) throw error
  }

  await fs.rename(zipPath, expectedPath)
  return expectedPath
}

export async function runCommand(command, args, options = {}) {
  const { cwd, stdio = 'inherit' } = options
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio,
    })
    child.on('error', (error) => {
      reject(new InstallerReleaseError('BUILD_COMMAND_FAILED', error.message, { cause: error }))
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new InstallerReleaseError(
            'BUILD_COMMAND_FAILED',
            `${command} ${args.join(' ')} failed with exit code ${code}.`
          )
        )
      }
    })
  })
}

export async function validateRemoteUrl(url, options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = options
  if (typeof fetchImpl !== 'function') {
    return { checked: false, ok: false, reason: 'fetch-unavailable' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method: 'HEAD', signal: controller.signal })
    return { checked: true, ok: response.ok, status: response.status }
  } catch (error) {
    return { checked: true, ok: false, reason: error?.name || 'request-failed' }
  } finally {
    clearTimeout(timeout)
  }
}

export async function writeInstallerManifest({
  repoRoot,
  zipPath,
  version,
  fileName,
  fileSizeBytes,
  sha256,
  gitMetadata,
}) {
  const rootVersion = await readPackageVersion(path.join(repoRoot, 'package.json'))
  const serverVersion = await readPackageVersion(path.join(repoRoot, 'local-branch-server', 'package.json'))
  const manifest = {
    version,
    file_name: fileName,
    file_size_bytes: fileSizeBytes,
    sha256,
    built_at: new Date().toISOString(),
    git_commit: gitMetadata?.git_commit || null,
    git_branch: gitMetadata?.git_branch || null,
    installer_type: 'offline-installer',
    minimum_supported_app_version: rootVersion,
    minimum_supported_local_server_version: serverVersion,
  }
  const manifestPath = path.join(
    path.dirname(zipPath),
    `${INSTALLER_PREFIX}-${version}.manifest.json`
  )
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { manifest, manifestPath }
}

export async function releaseOfflineInstaller(options = {}) {
  const repoRoot = options.repoRoot || process.cwd()
  const localServerDir = path.join(repoRoot, 'local-branch-server')
  const installersDir = path.join(repoRoot, 'release', 'installers')
  const version = await readInstallerVersion(path.join(localServerDir, 'package.json'))
  const installerUrl = options.installerUrl ?? process.env.HEALTHFLOW_INSTALLER_URL ?? process.env.VITE_HEALTHFLOW_INSTALLER_URL
  const buildRunner = options.buildRunner || (() => runCommand('npm', ['run', 'build:offline-installer'], { cwd: localServerDir }))

  await buildRunner()

  const locatedZip = await findInstallerZip(installersDir, version)
  const zipPath = await ensureVersionedInstallerName(locatedZip, installersDir, version)
  const stat = await fs.stat(zipPath)
  const sha256 = await calculateSha256(zipPath)
  const gitMetadata = options.gitMetadata || await getGitMetadata(repoRoot)
  const { manifest, manifestPath } = await writeInstallerManifest({
    repoRoot,
    zipPath,
    version,
    fileName: path.basename(zipPath),
    fileSizeBytes: stat.size,
    sha256,
    gitMetadata,
  })

  let validatedUrl = null
  let remoteValidation = { checked: false, ok: false, reason: 'url-not-provided' }
  if (installerUrl) {
    validatedUrl = validateInstallerUrl(installerUrl)
    if (options.checkRemoteUrl !== false) {
      remoteValidation = await validateRemoteUrl(validatedUrl, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      })
    }
  }

  return {
    version,
    zipPath,
    manifestPath,
    manifest,
    fileName: path.basename(zipPath),
    fileSizeBytes: stat.size,
    fileSize: formatBytes(stat.size),
    sha256,
    installerUrl: validatedUrl,
    remoteValidation,
    upload: {
      automated: false,
      reason: 'No existing installer upload mechanism was found in this repository.',
    },
  }
}

export function printReleaseSummary(result) {
  console.log('')
  console.log('HealthFlow offline installer release summary')
  console.log('--------------------------------------------')
  console.log(`Version:   ${result.version}`)
  console.log(`File:      ${result.fileName}`)
  console.log(`Size:      ${result.fileSize}`)
  console.log(`SHA-256:   ${result.sha256}`)
  console.log(`Path:      ${result.zipPath}`)
  console.log(`Manifest:  ${result.manifestPath}`)
  console.log(`Upload:    ${result.upload.automated ? 'completed' : result.upload.reason}`)
  if (result.installerUrl) {
    const status = result.remoteValidation.checked
      ? result.remoteValidation.ok
        ? `reachable (${result.remoteValidation.status})`
        : `not reachable (${result.remoteValidation.status || result.remoteValidation.reason})`
      : 'not checked'
    console.log(`URL:       ${result.installerUrl}`)
    console.log(`URL check: ${status}`)
  } else {
    console.log('URL:       not configured')
  }
  console.log('')
  console.log('Next steps:')
  console.log('1. Upload the ZIP to the approved HTTPS download location.')
  console.log('2. Import the manifest on the Super Admin Installer Releases page.')
  console.log('3. Add the final HTTPS ZIP URL, validate, then publish the release.')
  console.log('')
}

async function main() {
  try {
    const result = await releaseOfflineInstaller()
    printReleaseSummary(result)
    if (!result.installerUrl || result.remoteValidation.ok === false) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error('')
    console.error('HealthFlow offline installer release failed')
    console.error('------------------------------------------')
    console.error(`Code:    ${error.code || 'UNEXPECTED_ERROR'}`)
    console.error(`Message: ${error.message}`)
    if (error.details?.files) {
      console.error(`Files:   ${error.details.files.join(', ')}`)
    }
    console.error('')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
