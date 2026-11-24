// Checks a built update (manifest + ZIP) before it is published, without needing a Windows PC or the private key.
//
//   node verify-update-release.mjs --manifest <manifest.json> --package <update.zip>
//        [--public-key-file <public.pem> | --env-file <.env.example>] [--newer-than <1.2.3>]
//
// Exit code 0 = safe to publish, 1 = at least one problem (printed), 2 = bad usage.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const MAX_PACKAGE_BYTES = 60 * 1024 * 1024
const WARN_PACKAGE_BYTES = 20 * 1024 * 1024
const ROOT = 'local-branch-server/'

// Must stay identical to getManifestSigningPayload in src/updateManager.js (a test compares the two).
export const signingPayload = (manifest) =>
  [
    String(manifest.version || '').trim().replace(/^v/i, ''),
    String(manifest.channel || 'stable').trim().toLowerCase(),
    String(manifest.packageUrl || '').trim(),
    String(manifest.sha256 || '').trim().toLowerCase(),
    String(manifest.publishedAt || '').trim(),
  ].join('\n')

export const parseVersion = (value) => {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1).map(Number) : null
}

export const compareVersions = (left, right) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`Cannot compare versions "${left}" and "${right}".`)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

// Minimal ZIP reader (central directory), enough to list entries and read small files.
export const listZipEntries = (buffer) => {
  let end = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      end = index
      break
    }
  }
  if (end < 0) throw new Error('The update package is not a valid ZIP file.')
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const entries = []
  for (let item = 0; item < count; item += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The ZIP directory is damaged.')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/')
    entries.push({ name, method, compressedSize, size, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export const readZipEntry = (buffer, entry) => {
  const base = entry.localOffset
  if (buffer.readUInt32LE(base) !== 0x04034b50) throw new Error(`The ZIP entry ${entry.name} is damaged.`)
  const start = base + 30 + buffer.readUInt16LE(base + 26) + buffer.readUInt16LE(base + 28)
  const data = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return zlib.inflateRawSync(data)
  throw new Error(`The ZIP entry ${entry.name} uses an unsupported compression method.`)
}

const REQUIRED_ENTRIES = [
  'package.json',
  'package-lock.json',
  'scripts/apply-update.ps1',
  'src/server.js',
  'public/index.html',
]

// Anything below the server folder that must never travel inside an update.
const forbiddenReason = (relative) => {
  const lower = relative.toLowerCase()
  const base = lower.split('/').pop()
  if (lower === '.env' || (base.startsWith('.env') && base !== '.env.example' && base !== '.env.linux.example')) {
    return 'a settings file (.env)'
  }
  for (const folder of ['data/', 'logs/', 'node_modules/', 'updates/', 'runtime/', 'public/downloads/', 'public/branch-updates/']) {
    if (lower.startsWith(folder)) return `the ${folder.slice(0, -1)} folder`
  }
  if (/\.(sqlite|sqlite3|db|db-wal|db-shm|sqlite-wal|sqlite-shm|pem|pfx|key|log)$/.test(lower)) {
    return 'a database, key or log file'
  }
  if (/healthflow-offline-installer-.*\.zip$/.test(lower)) return 'an installer ZIP'
  return ''
}

export const verifyUpdateRelease = ({ manifest, zipBuffer, publicKey, newerThan = '' }) => {
  const errors = []
  const warnings = []
  const info = []
  const need = (field) => {
    if (!String(manifest?.[field] || '').trim()) errors.push(`The manifest has no ${field}.`)
  }
  ;['version', 'channel', 'packageUrl', 'sha256', 'publishedAt', 'signature'].forEach(need)
  if (errors.length) return { ok: false, errors, warnings, info }

  if (!/^https:\/\//i.test(manifest.packageUrl)) errors.push('The package URL must use HTTPS.')
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) errors.push('The manifest SHA-256 is not a 64-character hex value.')
  const packageName = manifest.packageUrl.split('/').pop()
  if (packageName !== `healthflow-branch-${String(manifest.version).replace(/^v/i, '')}.zip`) {
    errors.push(`The package file name (${packageName}) does not match the version ${manifest.version}.`)
  }

  try {
    const verified = crypto.verify(
      null,
      Buffer.from(signingPayload(manifest), 'utf8'),
      publicKey,
      Buffer.from(String(manifest.signature), 'base64')
    )
    if (!verified) errors.push('The manifest signature does not match the public key the installers ship with.')
    else info.push('Signature is valid for the shipped public key.')
  } catch (error) {
    errors.push(`The signature could not be checked: ${error.message}`)
  }

  const actualHash = crypto.createHash('sha256').update(zipBuffer).digest('hex')
  if (actualHash !== String(manifest.sha256).toLowerCase()) {
    errors.push(`The ZIP's SHA-256 (${actualHash}) does not match the manifest (${manifest.sha256}).`)
  } else {
    info.push('ZIP SHA-256 matches the manifest.')
  }
  if (zipBuffer.length > MAX_PACKAGE_BYTES) errors.push(`The ZIP is ${(zipBuffer.length / 1048576).toFixed(1)} MB; an update should be a few MB.`)
  else if (zipBuffer.length > WARN_PACKAGE_BYTES) warnings.push(`The ZIP is ${(zipBuffer.length / 1048576).toFixed(1)} MB, larger than usual.`)
  info.push(`ZIP size ${(zipBuffer.length / 1048576).toFixed(2)} MB.`)

  let entries = []
  try {
    entries = listZipEntries(zipBuffer).filter((entry) => !entry.name.endsWith('/'))
  } catch (error) {
    errors.push(error.message)
  }
  if (entries.length) {
    const outside = entries.filter((entry) => !entry.name.startsWith(ROOT))
    if (outside.length) errors.push(`These files are not inside ${ROOT}: ${outside.slice(0, 3).map((e) => e.name).join(', ')}.`)
    const relatives = entries.filter((entry) => entry.name.startsWith(ROOT)).map((entry) => entry.name.slice(ROOT.length))
    for (const required of REQUIRED_ENTRIES) {
      if (!relatives.includes(required)) errors.push(`The package is missing ${required}.`)
    }
    for (const relative of relatives) {
      const reason = forbiddenReason(relative)
      if (reason) errors.push(`The package contains ${relative}, which is ${reason}.`)
    }
    const packageEntry = entries.find((entry) => entry.name === `${ROOT}package.json`)
    if (packageEntry) {
      try {
        const inner = JSON.parse(readZipEntry(zipBuffer, packageEntry).toString('utf8').replace(/^\uFEFF/, ''))
        if (String(inner.version) !== String(manifest.version).replace(/^v/i, '')) {
          errors.push(`The package inside the ZIP is version ${inner.version}, but the manifest says ${manifest.version}.`)
        } else {
          info.push(`Package version ${inner.version} matches the manifest.`)
        }
      } catch (error) {
        errors.push(`Could not read package.json inside the ZIP: ${error.message}`)
      }
    }
    info.push(`${entries.length} files in the package.`)
  }

  if (newerThan) {
    try {
      if (compareVersions(manifest.version, newerThan) <= 0) {
        errors.push(`Version ${manifest.version} is not newer than ${newerThan}, so installed PCs would ignore it.`)
      } else {
        info.push(`Version ${manifest.version} is newer than ${newerThan}.`)
      }
    } catch (error) {
      errors.push(error.message)
    }
  }

  return { ok: errors.length === 0, errors, warnings, info }
}

export const readPublicKeyFromEnvFile = (envPath) => {
  const text = fs.readFileSync(envPath, 'utf8')
  const match = text.match(/^\s*HEALTHFLOW_UPDATE_PUBLIC_KEY\s*=\s*(.+?)\s*$/m)
  if (!match) throw new Error(`HEALTHFLOW_UPDATE_PUBLIC_KEY was not found in ${envPath}.`)
  return match[1].split('\\n').join('\n')
}

const readArgument = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : ''
}

const main = () => {
  const manifestPath = readArgument('manifest')
  const packagePath = readArgument('package')
  if (!manifestPath || !packagePath) {
    console.error('Usage: node verify-update-release.mjs --manifest <manifest.json> --package <update.zip> [--public-key-file <pem> | --env-file <.env.example>] [--newer-than <version>]')
    process.exit(2)
  }
  const publicKeyFile = readArgument('public-key-file')
  const envFile = readArgument('env-file')
  const publicKey = publicKeyFile
    ? fs.readFileSync(publicKeyFile, 'utf8')
    : readPublicKeyFromEnvFile(envFile || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.example'))
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  const result = verifyUpdateRelease({
    manifest,
    zipBuffer: fs.readFileSync(packagePath),
    publicKey,
    newerThan: readArgument('newer-than'),
  })
  result.info.forEach((line) => console.log(`OK    ${line}`))
  result.warnings.forEach((line) => console.log(`WARN  ${line}`))
  result.errors.forEach((line) => console.log(`FAIL  ${line}`))
  console.log(result.ok ? 'This update is safe to publish.' : 'This update must NOT be published.')
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
