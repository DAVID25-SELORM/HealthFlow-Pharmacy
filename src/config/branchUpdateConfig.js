export const BRANCH_UPDATE_MANIFEST_URL =
  'https://healthflowcloud.com/branch-updates/manifest.json'

export const BRANCH_UPDATE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAfYvTqK9SXyxhoKHFNuwOJwpzaoc4LXSeTMW2bSWAhiY=',
  '-----END PUBLIC KEY-----',
].join('\n')

export const HEALTHFLOW_INSTALLER_URL =
  import.meta.env.VITE_HEALTHFLOW_INSTALLER_URL ||
  'https://healthflowcloud.com/downloads/HealthFlow-Installer.zip'
