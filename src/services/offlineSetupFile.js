// The one-tap offline setup: building the setup text the shop computer reads, and the order of the steps.
//
// The setup text is the same KEY=value block Branch Sync Setup has always shown. The installer's
// Set-Up-HealthFlow-Offline.cmd finds a downloaded copy by its file name (SETUP_FILE_PREFIX), checks it,
// and deletes it after a successful setup. HealthFlow Cloud still stores only the token hash: the token is
// created in the browser, written to this file on the administrator's own computer, and never uploaded.

export const SETUP_FILE_PREFIX = 'HealthFlow-Setup-'

const PORT = '4780'

const fallbackCloudUrl = '<your-healthflow-cloud-url>'
const fallbackSyncKey = '<your-supabase-anon-or-publishable-key>'
const fallbackManifestUrl = '<your-signed-update-manifest-url>'
const fallbackPublicKey = '<your-update-public-key-with-escaped-newlines>'

// The exact lines Branch Sync Setup shows and copies. Kept here so the screen, the Copy button and the
// downloaded file can never disagree with each other (or with what the installer reads).
export const buildSetupBlockText = ({
  result,
  cloudUrl = '',
  syncKey = '',
  updateManifestUrl = '',
  updatePublicKey = '',
}) =>
  [
    `PORT=${PORT}`,
    `NHIA_CONFIG_SECRET_KEY=${result.nhiaConfigSecretKey}`,
    `ORGANIZATION_ID=${result.organizationId}`,
    `BRANCH_ID=${result.branchId}`,
    `BRANCH_SYNC_TOKEN=${result.branchSyncToken}`,
    `SUPABASE_URL=${cloudUrl || fallbackCloudUrl}`,
    `SUPABASE_SYNC_KEY=${syncKey || fallbackSyncKey}`,
    `HEALTHFLOW_UPDATE_MANIFEST_URL=${updateManifestUrl || fallbackManifestUrl}`,
    `HEALTHFLOW_UPDATE_PUBLIC_KEY=${updatePublicKey || fallbackPublicKey}`,
    'HEALTHFLOW_UPDATE_AUTO_CHECK_HOURS=24',
    'HEALTHFLOW_UPDATE_AUTO_INSTALL=false',
  ].join('\n')

// A file name that is safe on Windows and still recognisable: HealthFlow-Setup-Main-branch-server.txt
export const buildSetupFileName = (machineName = '') => {
  const readable = String(machineName)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${SETUP_FILE_PREFIX}${readable || 'computer'}.txt`
}

// Whether the block holds real cloud values. Without them the installer refuses the file, so the screen
// should not offer the one-tap button at all.
export const hasCloudConnectionValues = ({ cloudUrl = '', syncKey = '' } = {}) =>
  Boolean(String(cloudUrl).trim() && String(syncKey).trim())

export const buildSetupFile = ({ result, machineName = '', now = new Date(), ...blockOptions }) => {
  const expires = result.activationExpiresAt ? String(result.activationExpiresAt) : ''
  const header = [
    `# HealthFlow setup for ${String(machineName).replace(/[\r\n]+/g, ' ').trim() || 'a shop computer'}`,
    `# Created ${now.toISOString()}.`,
    expires ? `# Must be used before ${expires}; after that it stops working.` : '# Use it soon: unused setup codes expire.',
    '# This file lets one computer connect to your HealthFlow account. Keep it private.',
    '# HealthFlow Offline setup deletes it after a successful setup. Delete it yourself if you do not use it.',
    expires ? `# HEALTHFLOW_SETUP_EXPIRES=${expires}` : null,
    '',
  ]
    .filter((line) => line !== null)
    .join('\r\n')
  return {
    fileName: buildSetupFileName(machineName),
    contentType: 'text/plain;charset=utf-8',
    // Windows line endings so the file also reads correctly in Notepad.
    content: `${header}\r\n${buildSetupBlockText({ result, ...blockOptions }).replace(/\n/g, '\r\n')}\r\n`,
  }
}

// The order of the one tap. Nothing is registered unless the installer download can be prepared, so a
// setup code is never created (and its 48-hour clock never started) for a download that cannot happen.
//   prepareInstaller()      -> resolves to a download URL, or throws/returns '' with the reason already shown
//   register()              -> registers the machine and resolves to the result (token included)
//   saveSetupFile(file)     -> hands the file to the browser
//   startInstallerDownload(url)
export const runOneTapSetup = async ({
  prepareInstaller,
  register,
  saveSetupFile,
  startInstallerDownload,
  buildFile,
}) => {
  const installerUrl = await prepareInstaller()
  if (!installerUrl) return { started: false, reason: 'installer-unavailable' }

  const result = await register()
  if (!result) return { started: false, reason: 'registration-failed' }

  const file = buildFile(result)
  saveSetupFile(file)
  startInstallerDownload(installerUrl)
  return { started: true, result, fileName: file.fileName }
}
