export const BRANCH_UPDATE_MANIFEST_URL =
  'https://healthflowcloud.com/branch-updates/manifest.json'

export const BRANCH_UPDATE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAfYvTqK9SXyxhoKHFNuwOJwpzaoc4LXSeTMW2bSWAhiY=',
  '-----END PUBLIC KEY-----',
].join('\n')

// This is the exact legacy placeholder previously used as a silent fallback.
// It is not a real, published installer location for any deployment.
export const HEALTHFLOW_INSTALLER_FALLBACK_URL =
  'https://healthflowcloud.com/downloads/HealthFlow-Installer.zip'

// Decides whether an installer URL should be treated as "deliberately
// configured" for this deployment. Missing, blank, or equal to the known
// placeholder all count as not configured — none of them are evidence that a
// real installer package exists at that address.
export function resolveHealthflowInstallerUrl(rawValue) {
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (!trimmed || trimmed === HEALTHFLOW_INSTALLER_FALLBACK_URL) {
    return { url: trimmed || HEALTHFLOW_INSTALLER_FALLBACK_URL, configured: false }
  }
  return { url: trimmed, configured: true }
}

const ALLOWED_INSTALLER_PROTOCOLS = ['https:']
const SECRET_LOOKING_QUERY_PARAM = /token|secret|key|password|credential/i

// Structural safety checks independent of reachability: a URL can be
// "configured" and still be unsafe to open (wrong protocol, malformed,
// or carrying embedded credentials/tokens that must never be baked into
// a link the browser opens).
export function validateHealthflowInstallerUrl(urlString) {
  let parsed
  try {
    parsed = new URL(urlString)
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  if (!ALLOWED_INSTALLER_PROTOCOLS.includes(parsed.protocol)) {
    return { valid: false, reason: 'unsafe-protocol' }
  }
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'embedded-credentials' }
  }
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_LOOKING_QUERY_PARAM.test(key)) {
      return { valid: false, reason: 'embedded-credentials' }
    }
  }
  return { valid: true, reason: null }
}

const resolvedInstaller = resolveHealthflowInstallerUrl(
  import.meta.env.VITE_HEALTHFLOW_INSTALLER_URL
)

export const HEALTHFLOW_INSTALLER_URL = resolvedInstaller.url
export const HEALTHFLOW_INSTALLER_URL_CONFIGURED = resolvedInstaller.configured
export const HEALTHFLOW_INSTALLER_DETAILS_VALUE = resolvedInstaller.configured
  ? resolvedInstaller.url
  : 'Not configured for this deployment'
