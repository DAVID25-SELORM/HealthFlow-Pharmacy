import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const envPath = process.env.HEALTHFLOW_ENV_PATH
  ? path.resolve(process.env.HEALTHFLOW_ENV_PATH)
  : path.resolve(serverDir, '..', '.env')
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
const ENV_KEYS = {
  host: 'HOST',
  lanHostname: 'HEALTHFLOW_LAN_HOSTNAME',
  lanIp: 'HEALTHFLOW_LAN_IP',
  certPath: 'HEALTHFLOW_TLS_CERT_PATH',
  keyPath: 'HEALTHFLOW_TLS_KEY_PATH',
}

const isAbsolutePath = (value) =>
  path.isAbsolute(value) || path.win32.isAbsolute(value)

const validateSettings = (input = {}) => {
  const values = {
    lanHostname: String(input.lanHostname || '').trim().toLowerCase(),
    lanIp: String(input.lanIp || '').trim(),
    certPath: String(input.certPath || '').trim(),
    keyPath: String(input.keyPath || '').trim(),
  }
  if (values.lanHostname && !HOSTNAME_PATTERN.test(values.lanHostname)) {
    throw Object.assign(new Error('LAN server hostname is invalid.'), { status: 400 })
  }
  if (values.lanIp && net.isIP(values.lanIp) === 0) {
    throw Object.assign(new Error('LAN server IP is invalid.'), { status: 400 })
  }
  if (!isAbsolutePath(values.certPath) || !isAbsolutePath(values.keyPath)) {
    throw Object.assign(new Error('Certificate and key paths must be absolute server paths.'), { status: 400 })
  }
  if (!/\.(crt|cer|pem)$/i.test(values.certPath)) {
    throw Object.assign(new Error('Certificate path must end in .crt, .cer, or .pem.'), { status: 400 })
  }
  if (!/\.(key|pem)$/i.test(values.keyPath)) {
    throw Object.assign(new Error('Key path must end in .key or .pem.'), { status: 400 })
  }
  return values
}

const replaceEnvValue = (content, key, value) => {
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  return pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.replace(/\s*$/, '')}\n${line}\n`
}

export const inspectTlsRuntime = () => {
  const certExists = fs.existsSync(config.tls.certPath)
  const keyExists = fs.existsSync(config.tls.keyPath)
  const pfxExists = Boolean(config.tls.pfxPath && fs.existsSync(config.tls.pfxPath))
  let certificateValid = false
  let error = ''
  let credentials = null
  let certificateExpiresAt = ''
  let hostnameMatches = false

  if ((certExists && keyExists) || pfxExists) {
    try {
      credentials = pfxExists
        ? {
            pfx: fs.readFileSync(config.tls.pfxPath),
            passphrase: config.tls.pfxPassphrase,
          }
        : {
            cert: fs.readFileSync(config.tls.certPath),
            key: fs.readFileSync(config.tls.keyPath),
          }
      tls.createSecureContext(credentials)
      if (!certExists) {
        throw new Error('The public server certificate is required for hostname and expiry validation.')
      }
      const certificate = new crypto.X509Certificate(fs.readFileSync(config.tls.certPath))
      const validFrom = new Date(certificate.validFrom).getTime()
      const validTo = new Date(certificate.validTo).getTime()
      const now = Date.now()
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
        throw new Error('TLS certificate is not currently within its validity period.')
      }
      certificateExpiresAt = new Date(validTo).toISOString()
      const expectedHost = config.tls.lanHostname || config.tls.lanIp
      hostnameMatches = config.tls.lanHostname
        ? Boolean(certificate.checkHost(config.tls.lanHostname))
        : config.tls.lanIp
          ? Boolean(certificate.checkIP(config.tls.lanIp))
          : true
      if (expectedHost && !hostnameMatches) {
        throw new Error(`TLS certificate does not contain the configured LAN address ${expectedHost}.`)
      }
      certificateValid = true
    } catch (tlsError) {
      error = tlsError.message || 'Certificate or key could not be loaded.'
    }
  }

  const ready = certExists && (keyExists || pfxExists) && certificateValid
  const lanAddress = config.tls.lanHostname || config.tls.lanIp
  return {
    ready,
    status: ready ? 'Ready' : 'Not Configured',
    mode: ready ? 'https' : 'local-only',
    certExists,
    keyExists,
    pfxExists,
    credentialFormat: pfxExists ? 'pfx' : 'pem',
    certificateValid,
    certificateExpiresAt,
    hostnameMatches,
    certPath: config.tls.certPath,
    keyPath: config.tls.keyPath,
    lanHostname: config.tls.lanHostname,
    lanIp: config.tls.lanIp,
    publicUrl: ready && lanAddress ? `https://${lanAddress}:${config.port}` : '',
    warning: ready
      ? ''
      : 'Multi-computer offline access requires a trusted TLS certificate and key.',
    error,
    credentials,
  }
}

export const getPublicTlsStatus = (runtime = inspectTlsRuntime()) => {
  const { credentials: _credentials, ...status } = runtime
  return status
}

export const saveTlsSettings = (input) => {
  const values = validateSettings(input)
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const host = values.lanHostname || values.lanIp ? '0.0.0.0' : '127.0.0.1'
  content = replaceEnvValue(content, ENV_KEYS.host, host)
  content = replaceEnvValue(content, ENV_KEYS.lanHostname, values.lanHostname)
  content = replaceEnvValue(content, ENV_KEYS.lanIp, values.lanIp)
  content = replaceEnvValue(content, ENV_KEYS.certPath, values.certPath)
  content = replaceEnvValue(content, ENV_KEYS.keyPath, values.keyPath)
  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 })
  return {
    ...values,
    host,
    restartRequired: true,
    message: 'TLS settings saved. Restart the HealthFlow Local Branch Server to apply them.',
  }
}

export const saveCloudSyncSettings = (input = {}) => {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const organizationId = String(input.organizationId || '').trim()
  const branchId = String(input.branchId || '').trim()
  const branchSyncToken = String(input.branchSyncToken || '').trim()
  const supabaseUrl = String(input.supabaseUrl || '').trim().replace(/\/+$/, '')
  const supabaseSyncKey = String(input.supabaseSyncKey || '').trim()
  const nhiaConfigSecretKey = String(input.nhiaConfigSecretKey || '').trim()
  if (!uuidPattern.test(organizationId) || !uuidPattern.test(branchId)) {
    throw Object.assign(new Error('Organization and branch IDs must be valid UUIDs.'), { status: 400 })
  }
  if (branchSyncToken.length < 32) {
    throw Object.assign(new Error('Branch sync token is invalid.'), { status: 400 })
  }
  try {
    const url = new URL(supabaseUrl)
    if (url.protocol !== 'https:') throw new Error()
  } catch {
    throw Object.assign(new Error('Supabase URL must be a valid HTTPS URL.'), { status: 400 })
  }
  if (supabaseSyncKey.length < 20) {
    throw Object.assign(new Error('Supabase publishable key is invalid.'), { status: 400 })
  }

  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const values = {
    ORGANIZATION_ID: organizationId,
    BRANCH_ID: branchId,
    BRANCH_SYNC_TOKEN: branchSyncToken,
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SYNC_KEY: supabaseSyncKey,
    NHIA_CONFIG_SECRET_KEY: nhiaConfigSecretKey,
  }
  for (const [key, value] of Object.entries(values)) {
    content = replaceEnvValue(content, key, value)
  }
  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 })
  return {
    organizationId,
    branchId,
    supabaseUrl,
    restartRequired: true,
    message: 'Facility cloud synchronization settings saved. Restarting the Local Branch Server.',
  }
}
