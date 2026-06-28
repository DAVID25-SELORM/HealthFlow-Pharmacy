import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ClipboardCopy, RefreshCcw, Server, UploadCloud } from 'lucide-react'
import {
  applyBranchCloudConfiguration,
  createNhiaBatch,
  checkBranchServerUpdates,
  downloadNhiaBatchExport,
  getBranchInventory,
  getBranchOfflineReadiness,
  getBranchServerConfig,
  getBranchServerHealth,
  getSavedBranchToken,
  getBranchSyncStatus,
  getBranchUpdateStatus,
  getNhiaSummary,
  listNhiaClaims,
  installBranchServerUpdate,
  pullBranchInventory,
  pullBranchReferenceData,
  repairBranchSync,
  runBranchSync,
  saveBranchToken,
  submitPendingNhiaClaims,
  waitForBranchUpdateCompletion,
} from '../services/branchServerApi'
import { getNhiaApiSettings, saveNhiaApiSettings } from '../services/nhisService'
import { saveOfflinePosSnapshot } from '../services/offlinePosCache'
import {
  deactivateBranchSyncClient,
  listBranchSyncClients,
  listBranchSyncSetupOptions,
  registerBranchSyncClient,
} from '../services/tenantAdminService'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import {
  BRANCH_UPDATE_MANIFEST_URL,
  BRANCH_UPDATE_PUBLIC_KEY,
} from '../config/branchUpdateConfig'
import { readSignatureFileAsDataUrl } from '../utils/imageUpload'
import {
  applyNhiaFacilityDefaults,
  normalizeNhiaAccreditationExpiryDate,
} from '../utils/nhiaFacilityDefaults'
import './OfflineSync.css'

const WIZARD_STEPS = [
  { id: 'requirements',    label: 'Check system requirements',      detail: 'Verify the local server is reachable and healthy' },
  { id: 'check-updates',   label: 'Check for updates',              detail: 'Compare installed version with the latest available' },
  { id: 'download',        label: 'Download update package',        detail: 'Fetch signed package from HealthFlow update servers' },
  { id: 'backup',          label: 'Backup current installation',    detail: 'Create a restore checkpoint before applying changes' },
  { id: 'install',         label: 'Install HealthFlow components',  detail: 'Replace app, API, Node runtime, and dependencies' },
  { id: 'database',        label: 'Create / update local database', detail: 'Run schema migrations and provision all required tables' },
  { id: 'facility-data',   label: 'Synchronize operational data',   detail: 'Upload queued changes and download the branch inventory snapshot' },
  { id: 'reference-data',  label: 'Download supported facility data', detail: 'Sync patients, suppliers, purchases, claims, and supported reference records' },
  { id: 'nhia-config',     label: 'Configure NHIA & CLAIM-it',      detail: 'Verify NHIA credentials and endpoint configuration' },
  { id: 'services',        label: 'Verify background server',       detail: 'Confirm the installed branch server and worker are responding' },
  { id: 'health-checks',   label: 'Run health checks',              detail: 'Verify every component is operational before going offline' },
]

const WIZARD_STEP_TOTAL = WIZARD_STEPS.length
const blankWizardStepStatuses = () => WIZARD_STEPS.map(() => ({ status: 'idle', note: '' }))

const ENTITY_LABELS = {
  patients: 'Patients',
  claims: 'Claims',
  nhis_drugs: 'NHIS Drugs',
  nhis_clinical_rules: 'NHIS Clinical Rules',
  nhis_claims: 'NHIS Claims',
  suppliers: 'Suppliers',
  purchases: 'Purchases',
}

const EVENT_LABELS = {
  'sale.completed': 'POS Sales',
  'claim.submitted': 'POS Claims',
  'record.upsert': 'Module Records',
}

const formatDateTime = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

const getSummaryTotal = (summary, key) => Number(summary?.[key] || 0)

const blankNhiaForm = {
  facilityCode: '',
  providerNumber: '',
  schemeName: 'National Health Insurance',
  facilityType: '',
  pharmacyFacilityLevel: '',
  providerLevelCode: '',
  credentialCode: '',
  licenseNumber: '',
  providerTypeDescription: '',
  providerClassLevel: '',
  accreditationExpiryDate: '',
  claimsOfficerName: '',
  admissionPaymentOption: 'nhis_pays_admission',
  claimitValidationEnabled: true,
  claimsOfficerSignatureUrl: '',
  submitterId: '',
  apiBaseUrl: 'https://elig.nhia.gov.gh:5000',
  claimitSubmitBaseUrl: 'http://localhost:31719/json-api',
  claimEndpointPath: '/claims',
  ccCodeEndpointPath: '',
  memberLookupEndpointPath: '/api/hmis/genCCC',
  directApiEnabled: false,
  credentialMode: 'api_key',
  exportFormat: 'xml',
  nhisMemberDigits: 8,
  ghanaCardDigits: 10,
  maxRetryAttempts: 3,
  credentials: {
    apiKey: '',
    apiSecret: '',
    headerName: 'x-nhia-apikey',
    secretHeaderName: 'x-nhia-apisecret',
    headerPrefix: '',
    token: '',
    accessToken: '',
    clientId: '',
    clientSecret: '',
    username: '',
    password: '',
    tokenEndpointPath: '',
    certPem: '',
    keyPem: '',
    caPem: '',
    passphrase: '',
  },
}

const supabaseProjectUrl = import.meta.env.VITE_SUPABASE_URL || ''
const supabaseSyncKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  ''
const branchUpdateManifestUrl =
  import.meta.env.VITE_HEALTHFLOW_UPDATE_MANIFEST_URL ||
  BRANCH_UPDATE_MANIFEST_URL
const branchUpdatePublicKey = String(
  import.meta.env.VITE_HEALTHFLOW_UPDATE_PUBLIC_KEY ||
  BRANCH_UPDATE_PUBLIC_KEY
)
  .trim()
  .replace(/\r?\n/g, '\\n')

const buildNhiaForm = (settings, organization) => {
  const resolved = applyNhiaFacilityDefaults(settings, organization)
  return {
    ...blankNhiaForm,
    ...resolved,
    accreditationExpiryDate: normalizeNhiaAccreditationExpiryDate(resolved.accreditationExpiryDate),
    memberLookupEndpointPath: resolved.memberLookupEndpointPath || resolved.member_lookup_endpoint_path || resolved.memberLookupEndpoint || '/api/hmis/genCCC',
    claimitSubmitBaseUrl: resolved.claimitSubmitBaseUrl || resolved.claimit_submit_base_url || resolved.productionBaseUrl || resolved.production_base_url || '',
    credentials: {
      ...blankNhiaForm.credentials,
      apiKey: '',
      apiSecret: '',
      password: '',
    },
  }
}

const generateSetupToken = () => {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return window.btoa(binary)
}

const generateSetupUuid = () => {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  window.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const getDefaultBranchName = (organization) =>
  organization?.name ? `${organization.name} Main branch` : 'Main branch'

export default function OfflineSync() {
  const { organization, role, user, profile, branch } = useAuth()
  const { notify } = useNotification()
  const [config, setConfig] = useState(() => getBranchServerConfig())
  const [branchTokenForm, setBranchTokenForm] = useState(() => getSavedBranchToken())
  const [health, setHealth] = useState(null)
  const [status, setStatus] = useState(null)
  const [updateStatus, setUpdateStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState('')
  const [entityFilter, setEntityFilter] = useState('all')
  const [nhiaSettings, setNhiaSettings] = useState(null)
  const [nhiaSummary, setNhiaSummary] = useState(null)
  const [nhiaClaims, setNhiaClaims] = useState([])
  const [nhiaForm, setNhiaForm] = useState(blankNhiaForm)
  const [setupOptions, setSetupOptions] = useState({ organizations: [], branches: [] })
  const [setupForm, setSetupForm] = useState({
    organizationId: '',
    branchId: '',
    branchName: 'Main branch',
    branchAutoGenerated: false,
    name: 'Main branch server',
    branchSyncToken: '',
  })
  const [setupResult, setSetupResult] = useState(null)
  const [setupClients, setSetupClients] = useState([])
  const [setupLoading, setSetupLoading] = useState(false)
  const [setupClientAction, setSetupClientAction] = useState('')
  const [envCopied, setEnvCopied] = useState(false)
  const [setupApplied, setSetupApplied] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardPhase, setWizardPhase] = useState('idle')
  const [wizardStepStatuses, setWizardStepStatuses] = useState(blankWizardStepStatuses)
  const [wizardCurrentStep, setWizardCurrentStep] = useState(0)
  const [wizardSummary, setWizardSummary] = useState(null)
  const [wizardError, setWizardError] = useState('')
  const normalizedRole = String(role || '').toLowerCase()
  const canManageBranchToken = normalizedRole === 'admin' || normalizedRole === 'super_admin'
  const isSuperAdmin = normalizedRole === 'super_admin'

  const refreshStatus = useCallback(async ({ silent = false } = {}) => {
    const nextConfig = getBranchServerConfig()
    setConfig(nextConfig)
    setError('')

    if (!nextConfig.enabled || !nextConfig.token) {
      setHealth(null)
      setStatus(null)
      setUpdateStatus(null)
      setNhiaSettings(null)
      setNhiaSummary(null)
      setNhiaClaims([])
      setLoading(false)
      setError('Local branch server is not configured in this browser.')
      return
    }

    try {
      setLoading(true)
      const [nextHealth, nextStatus, nextUpdateStatus, nextNhiaSettings, nextNhiaSummary, nextNhiaClaims] = await Promise.all([
        getBranchServerHealth(),
        getBranchSyncStatus(),
        getBranchUpdateStatus().catch(() => null),
        getNhiaApiSettings({ organizationId: organization?.id || organization?.organization_id }).catch(() => null),
        getNhiaSummary().catch(() => null),
        listNhiaClaims({ limit: 8 }).catch(() => []),
      ])
      setHealth(nextHealth)
      setStatus(nextStatus)
      setUpdateStatus(nextUpdateStatus)
      setNhiaSettings(nextNhiaSettings)
      setNhiaSummary(nextNhiaSummary)
      setNhiaClaims(nextNhiaClaims)
      setNhiaForm(buildNhiaForm(nextNhiaSettings, organization))
      if (!silent) {
        notify('Offline sync status refreshed.', 'success')
      }
    } catch (statusError) {
      setHealth(null)
      setStatus(null)
      setUpdateStatus(null)
      setNhiaSettings(null)
      setNhiaSummary(null)
      setNhiaClaims([])
      setError(statusError.message || 'Unable to reach local branch server.')
      if (!silent) {
        notify(statusError.message || 'Unable to reach local branch server.', 'error')
      }
    } finally {
      setLoading(false)
    }
  }, [notify, organization])

  const pullInventoryAndCache = async () => {
    const result = await pullBranchInventory()
    const branchId = profile?.branch_id || branch?.id || ''
    const inventory = await getBranchInventory({ branchId, limit: 20000 })
    await saveOfflinePosSnapshot(user?.id, {
      drugs: inventory || [],
      drugsCacheMode: 'replace',
      shiftBranchId: branchId,
    })
    return result
  }

  useEffect(() => {
    void refreshStatus({ silent: true })
  }, [refreshStatus])

  useEffect(() => {
    if (!isSuperAdmin) {
      return
    }

    const loadSetupOptions = async () => {
      try {
        const options = await listBranchSyncSetupOptions()
        setSetupOptions(options)
        setSetupForm((current) => ({
          ...current,
          organizationId: current.organizationId || options.organizations?.[0]?.id || '',
        }))
      } catch (setupError) {
        notify(setupError.message || 'Unable to load branch setup options.', 'error')
      }
    }

    void loadSetupOptions()
  }, [isSuperAdmin, notify])

  const loadSetupClients = useCallback(async (organizationId) => {
    if (!isSuperAdmin || !organizationId) {
      setSetupClients([])
      return
    }

    try {
      setSetupClients(await listBranchSyncClients(organizationId))
    } catch (setupError) {
      setSetupClients([])
      notify(setupError.message || 'Unable to load registered branch machines.', 'error')
    }
  }, [isSuperAdmin, notify])

  useEffect(() => {
    void loadSetupClients(setupForm.organizationId)
  }, [loadSetupClients, setupForm.organizationId])

  const recordEntries = useMemo(
    () =>
      Object.entries(status?.recordsByEntity || {}).filter(
        ([entityType]) => entityFilter === 'all' || entityType === entityFilter
      ),
    [entityFilter, status]
  )

  const eventEntries = useMemo(
    () => Object.entries(status?.eventsByType || {}),
    [status]
  )

  const setupBranches = useMemo(
    () =>
      setupOptions.branches.filter(
        (branch) => !setupForm.organizationId || branch.organization_id === setupForm.organizationId
      ),
    [setupForm.organizationId, setupOptions.branches]
  )

  const selectSetupBranchForOrganization = useCallback((organizationId, branches, organizations) => {
    const organizationBranches = branches.filter((branch) => branch.organization_id === organizationId)
    const firstBranch = organizationBranches[0]
    const selectedOrganization = organizations.find(
      (setupOrganization) => setupOrganization.id === organizationId
    )

    if (firstBranch) {
      return {
        branchId: firstBranch.id,
        branchName: firstBranch.name || getDefaultBranchName(selectedOrganization),
        branchAutoGenerated: false,
      }
    }

    return {
      branchId: generateSetupUuid(),
      branchName: getDefaultBranchName(selectedOrganization),
      branchAutoGenerated: true,
    }
  }, [])

  useEffect(() => {
    if (!isSuperAdmin || !setupForm.organizationId) {
      return
    }

    if (setupBranches.length === 0 && setupForm.branchAutoGenerated && setupForm.branchId) {
      return
    }

    if (setupBranches.some((branch) => branch.id === setupForm.branchId)) {
      return
    }

    setSetupForm((current) => ({
      ...current,
      ...selectSetupBranchForOrganization(
        current.organizationId,
        setupOptions.branches,
        setupOptions.organizations
      ),
    }))
  }, [
    isSuperAdmin,
    selectSetupBranchForOrganization,
    setupBranches,
    setupForm.branchAutoGenerated,
    setupForm.branchId,
    setupForm.organizationId,
    setupOptions.branches,
    setupOptions.organizations,
  ])

  const runAction = async (action, label, operation) => {
    try {
      setBusyAction(action)
      const result = await operation()
      await refreshStatus({ silent: true })
      if (action === 'sync') {
        notify(
          `Checked ${result.total || 0} event${result.total === 1 ? '' : 's'}: ${result.synced || 0} synced, ${result.failed || 0} failed.`,
          result.failed ? 'warning' : 'success'
        )
      } else if (action === 'repair') {
        const syncResult = result.sync || {}
        notify(
          `Repair checked ${syncResult.total || 0} event${syncResult.total === 1 ? '' : 's'}: ${syncResult.synced || 0} synced, ${syncResult.failed || 0} failed.`,
          syncResult.failed ? 'warning' : 'success'
        )
      } else {
        notify(`${label} completed.`, 'success')
      }
    } catch (actionError) {
      notify(actionError.message || `${label} failed.`, 'error')
    } finally {
      setBusyAction('')
    }
  }

  const updateSetupForm = (field, value) => {
    setSetupForm((current) => ({ ...current, [field]: value }))
  }

  const registerSetupClient = async () => {
    try {
      setSetupLoading(true)
      setSetupResult(null)
      setSetupApplied(false)
      const branchSyncToken = setupForm.branchSyncToken.trim() || generateSetupToken()
      const nhiaConfigSecretKey = generateSetupToken()
      const result = await registerBranchSyncClient({
        ...setupForm,
        branchSyncToken,
      })
      setSetupForm((current) => ({ ...current, branchSyncToken }))
      setSetupResult({ ...result, nhiaConfigSecretKey })
      await loadSetupClients(setupForm.organizationId)
      notify('Branch sync client registered. Save the one-time setup block on the facility machine.', 'success')
    } catch (setupError) {
      notify(setupError.message || 'Unable to register branch sync client.', 'error')
    } finally {
      setSetupLoading(false)
    }
  }

  const applySetupToLocalServer = async () => {
    if (!setupResult) return
    try {
      setSetupClientAction('apply-config')
      const result = await applyBranchCloudConfiguration({
        organizationId: setupResult.organizationId,
        branchId: setupResult.branchId,
        branchSyncToken: setupResult.branchSyncToken,
        supabaseUrl: supabaseProjectUrl,
        supabaseSyncKey,
        nhiaConfigSecretKey: setupResult.nhiaConfigSecretKey,
      })
      setSetupApplied(true)
      notify(result.message || 'Facility configuration applied. The local server is restarting.', 'success', 7000)
    } catch (setupError) {
      notify(setupError.message || 'Unable to apply configuration to the Local Branch Server.', 'error')
    } finally {
      setSetupClientAction('')
    }
  }

  const deactivateSetupClient = async (client) => {
    if (!window.confirm(`Deactivate ${client.name}? This machine will stop syncing until it is registered again.`)) {
      return
    }

    try {
      setSetupClientAction(client.id)
      await deactivateBranchSyncClient({
        organizationId: setupForm.organizationId,
        syncClientId: client.id,
      })
      await loadSetupClients(setupForm.organizationId)
      notify('Branch sync client deactivated.', 'success')
    } catch (setupError) {
      notify(setupError.message || 'Unable to deactivate branch sync client.', 'error')
    } finally {
      setSetupClientAction('')
    }
  }

  const saveBrowserBranchToken = () => {
    const savedToken = saveBranchToken(branchTokenForm)
    setBranchTokenForm(savedToken)
    setConfig(getBranchServerConfig())
    notify(savedToken ? 'Branch token saved in this browser.' : 'Branch token removed from this browser.', 'success')
  }

  const openWizard = () => {
    setWizardOpen(true)
    setWizardPhase('idle')
    setWizardStepStatuses(blankWizardStepStatuses())
    setWizardCurrentStep(0)
    setWizardSummary(null)
    setWizardError('')
  }

  const setWizardStep = (index, status, note = '') => {
    setWizardCurrentStep(index)
    setWizardStepStatuses((prev) => prev.map((s, i) => (i === index ? { status, note } : s)))
  }

  const runOfflineSetupWizard = async () => {
    setWizardPhase('running')
    setWizardError('')
    let syncedCount = 0
    let nhiaConfigured = false
    let servicesOk = false
    let serverVersion = ''
    let hasUpdate = false

    try {
      // Step 0 — system requirements
      setWizardStep(0, 'running', 'Connecting to local branch server…')
      const health = await getBranchServerHealth()
      serverVersion = health?.version || ''
      setWizardStep(0, 'done', `Server${serverVersion ? ` v${serverVersion}` : ''} is healthy`)

      // Step 1 — check for updates
      setWizardStep(1, 'running', 'Contacting HealthFlow update server…')
      const updateCheck = await checkBranchServerUpdates()
      setUpdateStatus(updateCheck)
      hasUpdate = Boolean(updateCheck?.available) &&
        updateCheck?.installerSupported !== false &&
        updateCheck?.installerReady !== false
      setWizardStep(1, 'done', hasUpdate
        ? `Update available: ${updateCheck.currentVersion} → ${updateCheck.latestVersion}`
        : `Already on latest version${updateCheck?.currentVersion ? ` (${updateCheck.currentVersion})` : ''}`)

      if (hasUpdate) {
        setWizardStep(2, 'running', 'Downloading signed update package…')
        const installResult = await installBranchServerUpdate()
        setUpdateStatus(installResult)
        await waitForBranchUpdateCompletion({
          expectedVersion: updateCheck.latestVersion,
          onStatus: (installerStatus) => {
            setUpdateStatus(installerStatus)
            const state = String(installerStatus?.state || '').toLowerCase()
            const note = installerStatus?.message || 'Update is in progress.'

            if (state === 'downloading') {
              setWizardStep(2, 'running', note)
            } else if (state === 'stopping_service' || state === 'backing_up') {
              setWizardStep(2, 'done', 'Package downloaded and signature verified')
              setWizardStep(3, 'running', note)
            } else if (state === 'installing_files' || state === 'installing_dependencies') {
              setWizardStep(2, 'done', 'Package downloaded and signature verified')
              setWizardStep(3, 'done', 'Application and database restore points created')
              setWizardStep(4, 'running', note)
            } else if (state === 'restarting' || state === 'verifying') {
              setWizardStep(3, 'done', 'Application and database restore points created')
              setWizardStep(4, 'done', 'Application files and dependencies installed')
              setWizardStep(5, 'running', note)
            } else if (state === 'installed') {
              setWizardStep(4, 'done', 'Application files and dependencies installed')
              setWizardStep(5, 'done', 'Restarted API and database passed health verification')
            }
          },
        })
      } else {
        const skip = !updateCheck?.available ? 'Already on latest version' : 'Manual install required on this platform'
        setWizardStep(2, 'skipped', skip)
        setWizardStep(3, 'skipped', skip)
        setWizardStep(4, 'skipped', skip)
        setWizardStep(5, 'done', 'Database schema is current')
      }

      // Step 6 — operational data
      setWizardStep(6, 'running', 'Uploading queued changes and downloading branch inventory…')
      const inventoryResult = await pullBranchInventory()
      const syncResult = await runBranchSync()
      const syncStatus = await getBranchSyncStatus()
      syncedCount = Number(syncResult?.synced || 0) + Number(inventoryResult?.imported || 0)
      setStatus(syncStatus)
      setWizardStep(
        6,
        syncResult?.failed ? 'warning' : 'done',
        `${inventoryResult?.imported || 0} inventory records downloaded; ${syncResult?.synced || 0} queued changes uploaded`
      )

      // Step 7 — supported facility and reference data
      setWizardStep(7, 'running', 'Downloading supported facility and reference records…')
      const referenceResult = await pullBranchReferenceData()
      const referenceCount = Object.entries(referenceResult || {})
        .filter(([key]) => key !== 'pulledAt')
        .reduce((total, [, value]) => total + (Number(value) || 0), 0)
      syncedCount += referenceCount
      setWizardStep(7, 'done', `${referenceCount} facility/reference records downloaded`)

      // Step 8 — NHIA config
      setWizardStep(8, 'running', 'Verifying NHIA credentials and endpoint configuration…')
      try {
        const nhiaCheck = await getNhiaApiSettings({ organizationId: organization?.id || organization?.organization_id })
        nhiaConfigured = Boolean(nhiaCheck?.facilityCode && nhiaCheck?.providerNumber)
        if (nhiaConfigured) {
          setNhiaSettings(nhiaCheck)
          setNhiaForm(buildNhiaForm(nhiaCheck, organization))
        }
        setWizardStep(8, nhiaConfigured ? 'done' : 'warning',
          nhiaConfigured
            ? `Facility code ${nhiaCheck.facilityCode} · NHIA configured`
            : 'NHIA credentials not set — configure in the NHIA / CLAIM-it section below')
      } catch {
        setWizardStep(8, 'warning', 'Could not verify NHIA settings — configure manually below')
      }

      // Step 9 — installed background server
      setWizardStep(9, 'running', 'Verifying the installed background server…')
      const postHealth = await getBranchServerHealth()
      servicesOk = Boolean(postHealth?.ok)
      serverVersion = postHealth?.version || serverVersion
      setHealth(postHealth)
      setWizardStep(9, servicesOk ? 'done' : 'warning',
        servicesOk ? 'Local API and background sync worker are responding' : 'Background server health check failed')

      // Step 10 — final health checks
      setWizardStep(10, 'running', 'Running final system health verification…')
      const finalStatus = await getBranchSyncStatus()
      const readiness = await getBranchOfflineReadiness()
      setStatus(finalStatus)
      if (!readiness.ready) {
        const failures = (readiness.checks || [])
          .filter((item) => item.required && !item.passed)
          .map((item) => item.label)
        throw new Error(`Offline readiness checks failed: ${failures.join(', ') || 'unknown requirement'}.`)
      }
      setWizardStep(
        10,
        readiness.summary?.warnings ? 'warning' : 'done',
        readiness.summary?.warnings
          ? `Required checks passed with ${readiness.summary.warnings} warning(s)`
          : 'All required offline readiness checks passed'
      )

      setWizardSummary({
        serverVersion,
        syncedCount,
        nhiaConfigured,
        servicesOk,
        updateInstalled: hasUpdate,
        readiness,
      })
      setWizardPhase('done')
      notify('Offline setup checks completed successfully.', 'success')

    } catch (wizardErr) {
      const msg = wizardErr.message || 'Setup step failed.'
      setWizardError(msg)
      setWizardPhase('error')
      setWizardStepStatuses((prev) =>
        prev.map((s) => s.status === 'running' ? { status: 'error', note: msg } : s)
      )
    }
  }

  const checkForBranchUpdates = async () => {
    try {
      setBusyAction('update-check')
      const nextStatus = await checkBranchServerUpdates()
      setUpdateStatus(nextStatus)
      notify(nextStatus.message || 'Update check completed.', nextStatus.available ? 'warning' : 'success')
    } catch (updateError) {
      notify(updateError.message || 'Unable to check for branch server updates.', 'error')
    } finally {
      setBusyAction('')
    }
  }

  const installBranchUpdate = async () => {
    if (!window.confirm('Install the HealthFlow branch update now? The localhost app will restart briefly.')) {
      return
    }

    try {
      setBusyAction('update-install')
      const nextStatus = await installBranchServerUpdate()
      setUpdateStatus(nextStatus)
      notify('Update installation started. The localhost app will restart briefly.', 'success')
    } catch (updateError) {
      notify(updateError.message || 'Unable to install the branch server update.', 'error')
      setBusyAction('')
    }
  }

  const updateNhiaForm = (field, value) => {
    setNhiaForm((current) => ({ ...current, [field]: value }))
  }

  const updateNhiaCredential = (field, value) => {
    setNhiaForm((current) => ({
      ...current,
      credentials: { ...current.credentials, [field]: value },
    }))
  }

  const handleNhiaSignatureChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setError('')
      const signatureUrl = await readSignatureFileAsDataUrl(file)
      setNhiaForm((current) => ({ ...current, claimsOfficerSignatureUrl: signatureUrl }))
    } catch (signatureError) {
      setError(signatureError.message || 'Unable to upload claims officer signature.')
    } finally {
      event.target.value = ''
    }
  }

  const saveNhiaForm = async () => {
    await runAction('nhia-settings', 'NHIA settings save', async () => {
      const saved = await saveNhiaApiSettings({
        ...nhiaForm,
        organizationId: organization?.id || organization?.organization_id || nhiaForm.organizationId || nhiaForm.organization_id,
        accreditationExpiryDate: normalizeNhiaAccreditationExpiryDate(nhiaForm.accreditationExpiryDate),
      }, { organizationId: organization?.id || organization?.organization_id || nhiaForm.organizationId || nhiaForm.organization_id })
      const reloaded = await getNhiaApiSettings({ organizationId: organization?.id || organization?.organization_id || nhiaForm.organizationId || nhiaForm.organization_id })
      setNhiaSettings(reloaded || saved)
      setNhiaForm(buildNhiaForm(reloaded || saved, organization))
      return saved
    })
  }

  const submitNhiaClaims = async () => {
    await runAction('nhia-submit', 'NHIA pending claims submission', submitPendingNhiaClaims)
  }

  const downloadTextFile = ({ content, contentType, fileName }) => {
    const blob = new Blob([content], { type: contentType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const exportNhiaBatch = async (format) => {
    await runAction('nhia-export', `NHIA ${format.toUpperCase()} export`, async () => {
      const batch = await createNhiaBatch({ exportFormat: format })
      const exported = await downloadNhiaBatchExport(batch.id, format)
      downloadTextFile(exported)
      return batch
    })
  }

  const recentRecordFailures = status?.recentFailures?.records || []
  const recentEventFailures = status?.recentFailures?.events || []
  const hasFailures = recentRecordFailures.length > 0 || recentEventFailures.length > 0
  const isConnected = Boolean(health?.ok)

  const copyEnvBlock = useCallback((envText) => {
    navigator.clipboard.writeText(envText).then(() => {
      setEnvCopied(true)
      setTimeout(() => setEnvCopied(false), 2500)
    }).catch(() => {})
  }, [])

  const isNotConfigured = error === 'Local branch server is not configured in this browser.'
  const isUnreachable = !isNotConfigured && Boolean(error)
  const setupSteps = [
    { label: 'Register sync client', done: setupClients.some((c) => c.isActive) },
    { label: 'Apply configuration to facility server', done: setupApplied },
    { label: 'Start local branch server', done: isConnected },
    { label: 'Verify data sync', done: isConnected && Number(status?.summary?.synced || 0) > 0 },
  ]
  const branchUpdateMessage = updateStatus?.configured === false
    ? 'Automatic updates are not configured on this facility machine.'
    : updateStatus?.installerSupported === false
      ? `Automatic installation is not supported on ${updateStatus.platform || 'this platform'}.`
      : updateStatus?.installerReady === false
        ? 'The update helper is not installed. Rerun the branch service installer once.'
        : updateStatus?.message || 'Check for a signed HealthFlow branch update.'

  return (
    <div className="offline-sync-page">
      <div className="offline-sync-header">
        <div>
          <h1>Offline Sync</h1>
          <p>Monitor local branch server queues, module records, and failed sync attempts.</p>
        </div>
        <div className={`offline-sync-connection ${isConnected ? 'online' : 'offline'}`}>
          <Server size={18} />
          <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>

      {isNotConfigured && (
        <div className="offline-sync-getstarted">
          <div className="offline-sync-getstarted-icon"><Server size={28} /></div>
          <div>
            <strong>Branch server not connected to this browser</strong>
            <p>
              {canManageBranchToken
                ? 'Paste your branch token in the "Local Branch Token" section below to connect this browser to the local server.'
                : 'Ask your administrator to connect this machine to the local branch server.'}
              {isSuperAdmin && ' To set up a new machine, use the "Branch Sync Setup" section below.'}
            </p>
          </div>
        </div>
      )}
      {isUnreachable && (
        <div className="offline-sync-alert">
          {error}
          <span className="offline-sync-alert-hint">Make sure the HealthFlow local server is running on this machine (port 4780).</span>
        </div>
      )}

      {canManageBranchToken && (
        <section className="offline-sync-section branch-token-section">
          <div className="offline-sync-section-header">
            <div>
              <h2>Local Branch Token</h2>
              <p>Save the browser token used for protected local server API requests.</p>
            </div>
          </div>
          <div className="branch-token-form">
            <label>
              <span>Branch token</span>
              <input
                type="password"
                value={branchTokenForm}
                onChange={(event) => setBranchTokenForm(event.target.value)}
                placeholder="Paste the local branch token"
                autoComplete="new-password"
              />
            </label>
            <button className="btn btn-primary" type="button" onClick={saveBrowserBranchToken}>
              Save Branch Token
            </button>
          </div>
        </section>
      )}

      {canManageBranchToken && (
        <section className="offline-sync-section branch-update-section">
          <div className="offline-sync-section-header">
            <div>
              <h2>Local App Updates</h2>
              <p>Securely update the localhost server and offline app without replacing facility data or credentials.</p>
            </div>
          </div>
          <div className="branch-update-grid">
            <div>
              <span>Installed version</span>
              <strong>{updateStatus?.currentVersion || health?.version || '-'}</strong>
            </div>
            <div>
              <span>Latest version</span>
              <strong>{updateStatus?.latestVersion || '-'}</strong>
            </div>
            <div>
              <span>Update channel</span>
              <strong>{updateStatus?.channel || 'stable'}</strong>
            </div>
            <div>
              <span>Server platform</span>
              <strong>{updateStatus?.platform || '-'}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>{updateStatus?.state || (isConnected ? 'idle' : 'disconnected')}</strong>
            </div>
            <div>
              <span>Scheduled checks</span>
              <strong>
                {updateStatus?.autoCheckHours > 0
                  ? `Every ${updateStatus.autoCheckHours}h`
                  : 'Disabled'}
              </strong>
            </div>
            <div>
              <span>Automatic install</span>
              <strong>{updateStatus?.autoInstall ? 'Enabled' : 'Manual approval'}</strong>
            </div>
          </div>
          <div className="branch-update-message">
            {branchUpdateMessage}
          </div>
          {updateStatus?.releaseNotes && (
            <p className="branch-update-notes">{updateStatus.releaseNotes}</p>
          )}
          <div className="branch-setup-footer">
            <button
              className="btn btn-outline"
              type="button"
              onClick={() => void checkForBranchUpdates()}
              disabled={!isConnected || Boolean(busyAction) || updateStatus?.configured === false}
            >
              {busyAction === 'update-check' ? 'Checking...' : 'Check for Updates'}
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void installBranchUpdate()}
              disabled={
                !isConnected ||
                Boolean(busyAction) ||
                !updateStatus?.available ||
                updateStatus?.installerSupported === false ||
                updateStatus?.installerReady === false
              }
            >
              {busyAction === 'update-install' ? 'Starting...' : 'Download and Install'}
            </button>
            <button
              className="btn btn-accent wizard-launch-btn"
              type="button"
              onClick={openWizard}
              disabled={!isConnected || Boolean(busyAction)}
            >
              Offline Setup Wizard
            </button>
          </div>
        </section>
      )}

      {isSuperAdmin && (
        <section className="offline-sync-section branch-setup-section">
          <div className="offline-sync-section-header">
            <div>
              <h2>Branch Sync Setup</h2>
              <p>Register one pharmacy machine with Supabase and then place the returned values in its local server .env.</p>
            </div>
          </div>
          <div className="branch-setup-grid">
            <label>
              <span>Organization</span>
              <select
                value={setupForm.organizationId}
                onChange={(event) => {
                  const organizationId = event.target.value
                  setSetupForm((current) => ({
                    ...current,
                    organizationId,
                    ...selectSetupBranchForOrganization(
                      organizationId,
                      setupOptions.branches,
                      setupOptions.organizations
                    ),
                  }))
                  setSetupResult(null)
                  setSetupClients([])
                }}
                disabled={setupLoading}
              >
                {setupOptions.organizations.map((setupOrganization) => (
                  <option key={setupOrganization.id} value={setupOrganization.id}>
                    {setupOrganization.name} ({setupOrganization.subdomain || setupOrganization.status})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Branch</span>
              {setupBranches.length > 0 ? (
                <select
                  value={setupForm.branchId}
                  onChange={(event) => {
                    const branchId = event.target.value
                    const branch = setupBranches.find((setupBranch) => setupBranch.id === branchId)
                    setSetupForm((current) => ({
                      ...current,
                      branchId,
                      branchName: branch?.name || current.branchName,
                      branchAutoGenerated: false,
                    }))
                    setSetupResult(null)
                  }}
                  disabled={setupLoading}
                >
                  {setupBranches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}{branch.code ? ` (${branch.code})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="branch-generated-field">
                  <input
                    value={setupForm.branchId}
                    readOnly
                    placeholder="Generated branch UUID"
                    disabled={setupLoading}
                  />
                  <span>Auto-generated for this organization</span>
                </div>
              )}
            </label>
            <label>
              <span>Client name</span>
              <input
                value={setupForm.name}
                onChange={(event) => updateSetupForm('name', event.target.value)}
                disabled={setupLoading}
              />
            </label>
            <label className="branch-setup-wide">
              <span>Branch sync token</span>
              <input
                value={setupForm.branchSyncToken}
                onChange={(event) => {
                  updateSetupForm('branchSyncToken', event.target.value)
                  setSetupResult(null)
                }}
                placeholder="Leave blank to generate a secure token"
                disabled={setupLoading}
              />
            </label>
          </div>
          <div className="branch-setup-footer">
            <button
              className="btn btn-primary"
              type="button"
              onClick={registerSetupClient}
              disabled={setupLoading || !setupForm.organizationId || !setupForm.branchId}
            >
              {setupLoading ? 'Registering...' : 'Register Sync Client'}
            </button>
            <span>Run this once per pharmacy machine. Supabase stores only the token hash.</span>
          </div>
          {setupResult && (
            <div className="branch-setup-result">
              <p>This setup block is shown once. Copy it now — re-registering the same client name rotates its sync token.</p>
              <div className="branch-setup-env-wrapper">
                <pre className="branch-setup-env">{`PORT=4780
NHIA_CONFIG_SECRET_KEY=${setupResult.nhiaConfigSecretKey}
ORGANIZATION_ID=${setupResult.organizationId}
BRANCH_ID=${setupResult.branchId}
BRANCH_SYNC_TOKEN=${setupResult.branchSyncToken}
SUPABASE_URL=${supabaseProjectUrl || '<your-supabase-project-url>'}
SUPABASE_SYNC_KEY=${supabaseSyncKey || '<your-supabase-anon-or-publishable-key>'}
HEALTHFLOW_UPDATE_MANIFEST_URL=${branchUpdateManifestUrl || '<your-signed-update-manifest-url>'}
HEALTHFLOW_UPDATE_PUBLIC_KEY=${branchUpdatePublicKey || '<your-update-public-key-with-escaped-newlines>'}
HEALTHFLOW_UPDATE_AUTO_CHECK_HOURS=24
HEALTHFLOW_UPDATE_AUTO_INSTALL=false`}</pre>
                <button
                  className="btn btn-outline btn-sm branch-setup-copy-btn"
                  type="button"
                  onClick={() => copyEnvBlock(`PORT=4780\nNHIA_CONFIG_SECRET_KEY=${setupResult.nhiaConfigSecretKey}\nORGANIZATION_ID=${setupResult.organizationId}\nBRANCH_ID=${setupResult.branchId}\nBRANCH_SYNC_TOKEN=${setupResult.branchSyncToken}\nSUPABASE_URL=${supabaseProjectUrl || '<your-supabase-project-url>'}\nSUPABASE_SYNC_KEY=${supabaseSyncKey || '<your-supabase-anon-or-publishable-key>'}\nHEALTHFLOW_UPDATE_MANIFEST_URL=${branchUpdateManifestUrl || '<your-signed-update-manifest-url>'}\nHEALTHFLOW_UPDATE_PUBLIC_KEY=${branchUpdatePublicKey || '<your-update-public-key-with-escaped-newlines>'}\nHEALTHFLOW_UPDATE_AUTO_CHECK_HOURS=24\nHEALTHFLOW_UPDATE_AUTO_INSTALL=false`)}
                >
                  <ClipboardCopy size={14} />
                  {envCopied ? 'Copied!' : 'Copy'}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  onClick={() => void applySetupToLocalServer()}
                  disabled={
                    setupClientAction === 'apply-config' ||
                    !supabaseProjectUrl ||
                    !supabaseSyncKey ||
                    !isConnected
                  }
                >
                  {setupClientAction === 'apply-config' ? 'Applying...' : 'Apply to Local Server'}
                </button>
              </div>
            </div>
          )}

          <div className="branch-setup-checklist">
            <strong>Setup progress</strong>
            <ol>
              {setupSteps.map((step) => (
                <li key={step.label} className={step.done ? 'step-done' : 'step-pending'}>
                  {step.done ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                  {step.label}
                </li>
              ))}
            </ol>
          </div>
          <div className="branch-client-list">
            <div className="branch-client-list-header">
              <strong>Registered machines</strong>
              <span>Use the same client name to rotate its token.</span>
            </div>
            {setupClients.length === 0 ? (
              <p className="sync-empty">No branch machines registered for this facility.</p>
            ) : (
              setupClients.map((client) => (
                <div className="branch-client-row" key={client.id}>
                  <div>
                    <strong>{client.name}</strong>
                    <span>
                      {client.branchName || client.branchId}
                      {client.branchCode ? ` (${client.branchCode})` : ''}
                    </span>
                  </div>
                  <span>{client.lastSeenAt ? `Last seen ${formatDateTime(client.lastSeenAt)}` : 'Never connected'}</span>
                  <span className={client.isActive ? 'sync-client-active' : 'sync-client-inactive'}>
                    {client.isActive ? 'Active' : 'Inactive'}
                  </span>
                  {client.isActive && (
                    <button
                      className="btn btn-outline btn-sm"
                      type="button"
                      disabled={setupClientAction === client.id}
                      onClick={() => void deactivateSetupClient(client)}
                    >
                      {setupClientAction === client.id ? 'Deactivating...' : 'Deactivate'}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      <div className="offline-sync-actions">
        <button className="btn btn-outline" type="button" onClick={() => refreshStatus()} disabled={loading || Boolean(busyAction)}>
          <RefreshCcw size={16} />
          {loading ? 'Checking...' : 'Refresh'}
        </button>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => runAction('sync', 'Sync', runBranchSync)}
          disabled={!isConnected || Boolean(busyAction)}
        >
          <UploadCloud size={16} />
          {busyAction === 'sync' ? 'Syncing...' : 'Sync Now'}
        </button>
        <button
          className="btn btn-outline"
          type="button"
          onClick={() => runAction('repair', 'Sync repair', repairBranchSync)}
          disabled={!isConnected || Boolean(busyAction)}
        >
          Repair Failed Sync
        </button>
        <button
          className="btn btn-outline"
          type="button"
          onClick={() => runAction('inventory', 'Inventory pull', pullInventoryAndCache)}
          disabled={!isConnected || Boolean(busyAction)}
        >
          Pull Inventory
        </button>
        <button
          className="btn btn-outline"
          type="button"
          onClick={() => runAction('reference', 'Reference data pull', pullBranchReferenceData)}
          disabled={!isConnected || Boolean(busyAction)}
        >
          Pull Reference Data
        </button>
      </div>

      <section className="offline-sync-overview">
        <div className="sync-metric">
          <span>Pending</span>
          <strong>{getSummaryTotal(status, 'pending')}</strong>
        </div>
        <div className="sync-metric warning">
          <span>Failed</span>
          <strong>{getSummaryTotal(status, 'failed')}</strong>
        </div>
        <div className="sync-metric">
          <span>Synced</span>
          <strong>{getSummaryTotal(status, 'synced')}</strong>
        </div>
        <div className="sync-metric">
          <span>Total Events</span>
          <strong>{getSummaryTotal(status, 'total')}</strong>
        </div>
      </section>

      <section className="offline-sync-section">
        <div className="offline-sync-section-header">
          <div>
            <h2>NHIA / CLAIM-it</h2>
            <p>Local claim settings, submission status, and batch export.</p>
          </div>
          <div className="offline-sync-actions">
            <button
              className="btn btn-outline"
              type="button"
              onClick={submitNhiaClaims}
              disabled={!isConnected || Boolean(busyAction)}
            >
              Submit Pending
            </button>
            <button
              className="btn btn-outline"
              type="button"
              onClick={() => exportNhiaBatch('xml')}
              disabled={!isConnected || Boolean(busyAction)}
            >
              Export XML
            </button>
            <button
              className="btn btn-outline"
              type="button"
              onClick={() => exportNhiaBatch('json')}
              disabled={!isConnected || Boolean(busyAction)}
            >
              Export JSON
            </button>
          </div>
        </div>

        <div className="nhia-settings-grid">
          <label>
            <span>Scheme Name</span>
            <input
              value={nhiaForm.schemeName}
              onChange={(event) => updateNhiaForm('schemeName', event.target.value)}
            />
          </label>
          <label>
            <span>Facility Code</span>
            <input
              value={nhiaForm.facilityCode}
              onChange={(event) => updateNhiaForm('facilityCode', event.target.value)}
            />
          </label>
          <label>
            <span>Provider Number</span>
            <input
              value={nhiaForm.providerNumber}
              onChange={(event) => updateNhiaForm('providerNumber', event.target.value)}
            />
          </label>
          <label>
            <span>Facility Type</span>
            <input
              value={nhiaForm.facilityType}
              onChange={(event) => updateNhiaForm('facilityType', event.target.value)}
            />
          </label>
          <label>
            <span>Pharmacy Facility Level</span>
            <input
              value={nhiaForm.pharmacyFacilityLevel}
              onChange={(event) => updateNhiaForm('pharmacyFacilityLevel', event.target.value)}
            />
          </label>
          <label>
            <span>Provider Level Code</span>
            <input
              value={nhiaForm.providerLevelCode}
              onChange={(event) => updateNhiaForm('providerLevelCode', event.target.value)}
            />
          </label>
          <label>
            <span>Credential Code</span>
            <input
              value={nhiaForm.credentialCode}
              onChange={(event) => updateNhiaForm('credentialCode', event.target.value)}
            />
          </label>
          <label>
            <span>License Number</span>
            <input
              value={nhiaForm.licenseNumber}
              onChange={(event) => updateNhiaForm('licenseNumber', event.target.value)}
            />
          </label>
          <label>
            <span>Provider Class / Level</span>
            <select
              value={nhiaForm.providerClassLevel}
              onChange={(event) => updateNhiaForm('providerClassLevel', event.target.value)}
            >
              <option value="">Select</option>
              <option value="B1">B1</option>
              <option value="B2">B2</option>
              <option value="C">C</option>
              <option value="D">D</option>
              <option value="M">M</option>
              <option value="SM">SM</option>
            </select>
          </label>
          <label>
            <span>Provider Type</span>
            <select
              value={nhiaForm.providerTypeDescription}
              onChange={(event) => updateNhiaForm('providerTypeDescription', event.target.value)}
            >
              <option value="">Select</option>
              <option value="Tertiary care hospital">Tertiary care hospital</option>
              <option value="Secondary care hospital">Secondary care hospital</option>
              <option value="Primary care hospital">Primary care hospital</option>
              <option value="Private Primary Care Hospital">Private Primary Care Hospital</option>
              <option value="CHAG Primary Care Hospital">CHAG Primary Care Hospital</option>
              <option value="Health centers (Public, Private, CHAG)">Health centers (Public, Private, CHAG)</option>
              <option value="Maternity homes">Maternity homes</option>
              <option value="Private clinics">Private clinics</option>
              <option value="Dental clinics">Dental clinics</option>
              <option value="Eye centers">Eye centers</option>
              <option value="Diagnostic centers">Diagnostic centers</option>
              <option value="CHPS Compounds">CHPS Compounds</option>
              <option value="Pharmacy">Community Pharmacy</option>
              <option value="Hospital Pharmacy">Hospital Pharmacy</option>
              <option value="Clinic">Clinic</option>
              <option value="Hospital">Hospital</option>
            </select>
          </label>
          <label>
            <span>Admission Option</span>
            <select
              value={nhiaForm.admissionPaymentOption}
              onChange={(event) => updateNhiaForm('admissionPaymentOption', event.target.value)}
            >
              <option value="nhis_pays_admission">NHIS pays admission</option>
              <option value="patient_pays_admission">Patient pays admission</option>
              <option value="not_applicable">Not applicable</option>
            </select>
          </label>
          <label>
            <span>Accreditation Expiry Date</span>
            <input
              type="date"
              value={nhiaForm.accreditationExpiryDate}
              onChange={(event) => updateNhiaForm('accreditationExpiryDate', normalizeNhiaAccreditationExpiryDate(event.target.value))}
            />
          </label>
          <label>
            <span>Claims Officer</span>
            <input
              value={nhiaForm.claimsOfficerName}
              onChange={(event) => updateNhiaForm('claimsOfficerName', event.target.value)}
            />
          </label>
          <label className="nhia-signature-field">
            <span>Claims Officer Signature</span>
            {nhiaForm.claimsOfficerSignatureUrl && (
              <img
                src={nhiaForm.claimsOfficerSignatureUrl}
                alt="Claims officer signature preview"
                className="nhia-signature-preview"
              />
            )}
            <input type="file" accept="image/*" onChange={handleNhiaSignatureChange} />
            {nhiaForm.claimsOfficerSignatureUrl && (
              <button
                className="btn btn-outline btn-sm"
                type="button"
                onClick={() => updateNhiaForm('claimsOfficerSignatureUrl', '')}
              >
                Remove signature
              </button>
            )}
          </label>
          <label>
            <span>Submitter ID</span>
            <input
              value={nhiaForm.submitterId}
              onChange={(event) => updateNhiaForm('submitterId', event.target.value)}
            />
          </label>
          <label>
            <span>API Base URL</span>
            <input
              value={nhiaForm.apiBaseUrl}
              onChange={(event) => updateNhiaForm('apiBaseUrl', event.target.value)}
            />
          </label>
          <label>
            <span>Claim Endpoint</span>
            <input
              value={nhiaForm.claimEndpointPath}
              onChange={(event) => updateNhiaForm('claimEndpointPath', event.target.value)}
            />
          </label>
          <label>
            <span>CC Code Endpoint</span>
            <input
              value={nhiaForm.ccCodeEndpointPath}
              placeholder="Optional"
              onChange={(event) => updateNhiaForm('ccCodeEndpointPath', event.target.value)}
            />
          </label>
          <label>
            <span>Member Lookup Endpoint</span>
            <input
              value={nhiaForm.memberLookupEndpointPath}
              placeholder="/api/hmis/genCCC"
              onChange={(event) => updateNhiaForm('memberLookupEndpointPath', event.target.value)}
            />
          </label>
          <label>
            <span>CLAIM-it Submit URL (local)</span>
            <input
              value={nhiaForm.claimitSubmitBaseUrl}
              placeholder="http://localhost:31719/json-api"
              onChange={(event) => updateNhiaForm('claimitSubmitBaseUrl', event.target.value)}
            />
          </label>
          <label>
            <span>Authentication mode</span>
            <select
              value={nhiaForm.credentialMode}
              onChange={(event) => updateNhiaForm('credentialMode', event.target.value)}
            >
              <option value="claimit_token">CLAIM-it credentials / Custom CLAIM-it authentication</option>
              <option value="api_key">API key</option>
              <option value="bearer_token">Bearer token</option>
              <option value="oauth_client">OAuth2/client credentials</option>
              <option value="basic_auth">Username/password</option>
              <option value="custom">Custom integration</option>
            </select>
          </label>
          <label>
            <span>Export Format</span>
            <select
              value={nhiaForm.exportFormat}
              onChange={(event) => updateNhiaForm('exportFormat', event.target.value)}
            >
              <option value="xml">XML</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <label>
            <span>NHIS Digits</span>
            <input
              type="number"
              min="1"
              max="30"
              value={nhiaForm.nhisMemberDigits}
              onChange={(event) => updateNhiaForm('nhisMemberDigits', event.target.value)}
            />
          </label>
          <label>
            <span>Ghana Card Digits</span>
            <input
              type="number"
              min="1"
              max="30"
              value={nhiaForm.ghanaCardDigits}
              onChange={(event) => updateNhiaForm('ghanaCardDigits', event.target.value)}
            />
          </label>
          <label>
            <span>Retry Attempts</span>
            <input
              type="number"
              min="1"
              max="10"
              value={nhiaForm.maxRetryAttempts}
              onChange={(event) => updateNhiaForm('maxRetryAttempts', event.target.value)}
            />
          </label>
          <label className="nhia-toggle">
            <input
              type="checkbox"
              checked={Boolean(nhiaForm.directApiEnabled)}
              onChange={(event) => updateNhiaForm('directApiEnabled', event.target.checked)}
            />
            <span>Direct API Enabled</span>
          </label>
          <label className="nhia-toggle">
            <input
              type="checkbox"
              checked={nhiaForm.claimitValidationEnabled !== false}
              onChange={(event) => updateNhiaForm('claimitValidationEnabled', event.target.checked)}
            />
            <span>Allow CLAIM-it Validation</span>
          </label>

          {nhiaForm.credentialMode === 'api_key' && (
            <>
              <label className="nhia-wide">
                <span>API Key {nhiaSettings?.credentialSummary?.apiKey ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.apiKey}
                  onChange={(event) => updateNhiaCredential('apiKey', event.target.value)}
                />
              </label>
              <label>
                <span>API Key Header</span>
                <input
                  value={nhiaForm.credentials.headerName}
                  placeholder="x-api-key"
                  onChange={(event) => updateNhiaCredential('headerName', event.target.value)}
                />
              </label>
              <label>
                <span>Header Prefix</span>
                <input
                  value={nhiaForm.credentials.headerPrefix}
                  placeholder="Optional"
                  onChange={(event) => updateNhiaCredential('headerPrefix', event.target.value)}
                />
              </label>
              <label className="nhia-wide">
                <span>API Secret {nhiaSettings?.credentialSummary?.apiSecret ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.apiSecret}
                  onChange={(event) => updateNhiaCredential('apiSecret', event.target.value)}
                />
              </label>
              <label>
                <span>Secret Header</span>
                <input
                  value={nhiaForm.credentials.secretHeaderName}
                  placeholder="x-api-secret"
                  onChange={(event) => updateNhiaCredential('secretHeaderName', event.target.value)}
                />
              </label>
              <label>
                <span>Username {nhiaSettings?.credentialSummary?.username ? '(saved)' : ''}</span>
                <input
                  value={nhiaForm.credentials.username}
                  onChange={(event) => updateNhiaCredential('username', event.target.value)}
                />
              </label>
              <label>
                <span>Password {nhiaSettings?.credentialSummary?.password ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.password}
                  onChange={(event) => updateNhiaCredential('password', event.target.value)}
                />
              </label>
            </>
          )}

          {nhiaForm.credentialMode === 'bearer_token' && (
            <label className="nhia-wide">
              <span>Bearer token {nhiaSettings?.credentialSummary?.token || nhiaSettings?.credentialSummary?.apiKey ? '(saved)' : ''}</span>
              <input
                type="password"
                value={nhiaForm.credentials.token || nhiaForm.credentials.apiKey}
                onChange={(event) => {
                  updateNhiaCredential('token', event.target.value)
                  updateNhiaCredential('apiKey', event.target.value)
                }}
              />
            </label>
          )}

          {nhiaForm.credentialMode === 'oauth_client' && (
            <>
              <label className="nhia-wide">
                <span>OAuth access token {nhiaSettings?.credentialSummary?.accessToken || nhiaSettings?.credentialSummary?.token ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.accessToken || nhiaForm.credentials.token || nhiaForm.credentials.apiKey}
                  onChange={(event) => {
                    updateNhiaCredential('accessToken', event.target.value)
                    updateNhiaCredential('token', event.target.value)
                    updateNhiaCredential('apiKey', event.target.value)
                  }}
                />
              </label>
              <label>
                <span>Client ID {nhiaSettings?.credentialSummary?.clientId ? '(saved)' : ''}</span>
                <input
                  value={nhiaForm.credentials.clientId}
                  onChange={(event) => updateNhiaCredential('clientId', event.target.value)}
                />
              </label>
              <label>
                <span>Client Secret {nhiaSettings?.credentialSummary?.clientSecret ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.clientSecret}
                  onChange={(event) => updateNhiaCredential('clientSecret', event.target.value)}
                />
              </label>
            </>
          )}

          {nhiaForm.credentialMode === 'basic_auth' && (
            <>
              <label>
                <span>Username {nhiaSettings?.credentialSummary?.username ? '(saved)' : ''}</span>
                <input
                  value={nhiaForm.credentials.username}
                  onChange={(event) => updateNhiaCredential('username', event.target.value)}
                />
              </label>
              <label>
                <span>Password {nhiaSettings?.credentialSummary?.password ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.password}
                  onChange={(event) => updateNhiaCredential('password', event.target.value)}
                />
              </label>
            </>
          )}

          {nhiaForm.credentialMode === 'claimit_token' && (
            <>
              <label>
                <span>CLAIM-it Username {nhiaSettings?.credentialSummary?.username ? '(saved)' : ''}</span>
                <input
                  value={nhiaForm.credentials.username}
                  onChange={(event) => updateNhiaCredential('username', event.target.value)}
                />
              </label>
              <label>
                <span>CLAIM-it Password {nhiaSettings?.credentialSummary?.password ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.password}
                  onChange={(event) => updateNhiaCredential('password', event.target.value)}
                />
              </label>
              <label>
                <span>Token Endpoint</span>
                <input
                  value={nhiaForm.credentials.tokenEndpointPath}
                  placeholder="/token"
                  onChange={(event) => updateNhiaCredential('tokenEndpointPath', event.target.value)}
                />
              </label>
            </>
          )}

          {nhiaForm.credentialMode === 'custom' && (
            <>
              <label className="nhia-wide">
                <span>Certificate PEM {nhiaSettings?.credentialSummary?.certPem ? '(saved)' : ''}</span>
                <textarea
                  rows="4"
                  value={nhiaForm.credentials.certPem}
                  onChange={(event) => updateNhiaCredential('certPem', event.target.value)}
                />
              </label>
              <label className="nhia-wide">
                <span>Private Key PEM {nhiaSettings?.credentialSummary?.keyPem ? '(saved)' : ''}</span>
                <textarea
                  rows="4"
                  value={nhiaForm.credentials.keyPem}
                  onChange={(event) => updateNhiaCredential('keyPem', event.target.value)}
                />
              </label>
              <label>
                <span>Passphrase {nhiaSettings?.credentialSummary?.passphrase ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.passphrase}
                  onChange={(event) => updateNhiaCredential('passphrase', event.target.value)}
                />
              </label>
              <label className="nhia-wide">
                <span>CA PEM {nhiaSettings?.credentialSummary?.caPem ? '(saved)' : ''}</span>
                <textarea
                  rows="3"
                  value={nhiaForm.credentials.caPem}
                  onChange={(event) => updateNhiaCredential('caPem', event.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <div className="nhia-settings-footer">
          <span>
            Draft {nhiaSummary?.draft || 0} | Ready {nhiaSummary?.ready || 0} | Submitted{' '}
            {nhiaSummary?.submitted || 0} | Failed {nhiaSummary?.failed || 0}
          </span>
          <button
            className="btn btn-primary"
            type="button"
            onClick={saveNhiaForm}
            disabled={!isConnected || Boolean(busyAction)}
          >
            {busyAction === 'nhia-settings' ? 'Saving...' : 'Save NHIA Settings'}
          </button>
        </div>

        <div className="nhia-claims-table-wrap">
          {nhiaClaims.length === 0 ? (
            <div className="sync-empty">No local NHIA claims found.</div>
          ) : (
            <table className="nhia-claims-table">
              <thead>
                <tr>
                  <th>Claim</th>
                  <th>Patient</th>
                  <th>Member No.</th>
                  <th>Status</th>
                  <th>CC Code</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {nhiaClaims.map((claim) => (
                  <tr key={claim.id}>
                    <td>{claim.claimNumber}</td>
                    <td>{claim.patientName}</td>
                    <td>{claim.memberNumber}</td>
                    <td>{claim.status}</td>
                    <td>{claim.ccCode || '-'}</td>
                    <td>GHS {Number(claim.totalAmount || 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="offline-sync-section">
        <div className="offline-sync-section-header">
          <div>
            <h2>Module Records</h2>
            <p>Pending / failed / synced records stored by the branch server.</p>
          </div>
          <select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value)}>
            <option value="all">All modules</option>
            {Object.keys(status?.recordsByEntity || {}).map((entityType) => (
              <option key={entityType} value={entityType}>
                {ENTITY_LABELS[entityType] || entityType}
              </option>
            ))}
          </select>
        </div>

        <div className="sync-record-grid">
          {recordEntries.length === 0 ? (
            <div className="sync-empty">No branch module records found.</div>
          ) : (
            recordEntries.map(([entityType, summary]) => (
              <div className="sync-record-row" key={entityType}>
                <strong>{ENTITY_LABELS[entityType] || entityType}</strong>
                <span>{summary.pending || 0} pending</span>
                <span>{summary.failed || 0} failed</span>
                <span>{summary.synced || 0} synced</span>
                <span>{summary.total || 0} total</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="offline-sync-section">
        <div className="offline-sync-section-header">
          <div>
            <h2>Outbox Events</h2>
            <p>Sync events waiting to be pushed to Supabase.</p>
          </div>
        </div>
        <div className="sync-record-grid">
          {eventEntries.length === 0 ? (
            <div className="sync-empty">No outbox events found.</div>
          ) : (
            eventEntries.map(([eventType, summary]) => (
              <div className="sync-record-row" key={eventType}>
                <strong>{EVENT_LABELS[eventType] || eventType}</strong>
                <span>{summary.pending || 0} pending</span>
                <span>{summary.syncing || 0} syncing</span>
                <span>{summary.failed || 0} failed</span>
                <span>{summary.synced || 0} synced</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className={`offline-sync-section ${hasFailures ? 'has-failures' : ''}`}>
        <div className="offline-sync-section-header">
          <div>
            <h2>Failures</h2>
            <p>Most recent records or outbox events that need attention.</p>
          </div>
          {hasFailures ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
        </div>

        {!hasFailures ? (
          <div className="sync-empty success">No recent sync failures.</div>
        ) : (
          <div className="sync-failure-tables">
            {recentRecordFailures.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Module</th>
                    <th>Updated</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRecordFailures.map((failure) => (
                    <tr key={`${failure.entity_type}-${failure.id}`}>
                      <td>{failure.id}</td>
                      <td>{ENTITY_LABELS[failure.entity_type] || failure.entity_type}</td>
                      <td>{formatDateTime(failure.updated_at)}</td>
                      <td>{failure.last_sync_error || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {recentEventFailures.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Entity</th>
                    <th>Updated</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEventFailures.map((failure) => (
                    <tr key={failure.id}>
                      <td>{EVENT_LABELS[failure.event_type] || failure.event_type}</td>
                      <td>{ENTITY_LABELS[failure.entity_type] || failure.entity_type}</td>
                      <td>{formatDateTime(failure.updated_at)}</td>
                      <td>{failure.last_error || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <p className="offline-sync-footnote">
        Branch server: {config.url || 'Not configured'}
      </p>

      {wizardOpen && (
        <div className="wizard-overlay" role="dialog" aria-modal="true" aria-label="Offline Setup Wizard">
          <div className="wizard-modal">
            <div className="wizard-header">
              <div className="wizard-header-text">
                <h2>Offline Setup Wizard</h2>
                <p>This wizard finalizes and verifies an installed HealthFlow branch server.</p>
              </div>
              {wizardPhase !== 'running' && (
                <button className="wizard-close-btn" type="button" aria-label="Close" onClick={() => setWizardOpen(false)}>✕</button>
              )}
            </div>

            {wizardPhase === 'idle' && (
              <div className="wizard-intro">
                <p>The wizard performs <strong>{WIZARD_STEP_TOTAL} verified steps</strong> to update the installed local server, synchronize supported offline data, and run production readiness checks.</p>
                <p>This typically takes <strong>5 – 15 minutes</strong> depending on your internet speed and data volume. Do not close the browser tab while the wizard runs.</p>
                <div className="wizard-footer">
                  <button className="btn btn-secondary" type="button" onClick={() => setWizardOpen(false)}>Cancel</button>
                  <button className="btn btn-primary" type="button" onClick={() => void runOfflineSetupWizard()}>Start Setup</button>
                </div>
              </div>
            )}

            {(wizardPhase === 'running' || wizardPhase === 'done' || wizardPhase === 'error') && (
              <>
                <div className="wizard-progress-bar-wrap">
                  <div
                    className="wizard-progress-bar"
                    style={{
                      width: `${Math.round(
                        (wizardStepStatuses.filter((s) => s.status !== 'idle' && s.status !== 'running').length / WIZARD_STEP_TOTAL) * 100
                      )}%`,
                    }}
                  />
                </div>
                <p className="wizard-progress-label">
                  Step {Math.min(wizardCurrentStep + 1, WIZARD_STEP_TOTAL)} of {WIZARD_STEP_TOTAL}
                </p>

                <ol className="wizard-steps">
                  {WIZARD_STEPS.map((step, idx) => {
                    const { status, note } = wizardStepStatuses[idx] || { status: 'idle', note: '' }
                    return (
                      <li key={step.id} className={`wizard-step wizard-step--${status}`}>
                        <span className="wizard-step-icon" aria-hidden="true">
                          {status === 'done'    && '✓'}
                          {status === 'skipped' && '–'}
                          {status === 'warning' && '⚠'}
                          {status === 'error'   && '✕'}
                          {status === 'running' && <span className="wizard-spinner" />}
                          {status === 'idle'    && <span className="wizard-step-dot" />}
                        </span>
                        <span className="wizard-step-body">
                          <span className="wizard-step-label">{step.label}</span>
                          {note
                            ? <span className="wizard-step-note">{note}</span>
                            : status === 'idle' && <span className="wizard-step-note wizard-step-note--muted">{step.detail}</span>}
                        </span>
                      </li>
                    )
                  })}
                </ol>

                {wizardPhase === 'error' && wizardError && (
                  <div className="wizard-error-banner">
                    <strong>Setup failed:</strong> {wizardError}
                    <br />
                    <small>You can close this dialog, fix the issue, and run the wizard again.</small>
                  </div>
                )}

                {wizardPhase === 'done' && wizardSummary && (
                  <div className="wizard-summary">
                    <h3>Setup Complete</h3>
                    <ul>
                      <li className="wizard-summary-ok">✓ Local server running{wizardSummary.serverVersion ? ` (v${wizardSummary.serverVersion})` : ''}</li>
                      <li className="wizard-summary-ok">✓ Database ready</li>
                      {wizardSummary.updateInstalled && <li className="wizard-summary-ok">✓ Software updated to latest version</li>}
                      <li className="wizard-summary-ok">✓ Supported offline data synchronized ({wizardSummary.syncedCount.toLocaleString()} records processed)</li>
                      <li className={wizardSummary.nhiaConfigured ? 'wizard-summary-ok' : 'wizard-summary-warn'}>
                        {wizardSummary.nhiaConfigured ? '✓ NHIA configured' : '⚠ NHIA credentials need configuration'}
                      </li>
                      <li className={wizardSummary.servicesOk ? 'wizard-summary-ok' : 'wizard-summary-warn'}>
                        {wizardSummary.servicesOk ? '✓ Background server responding' : '⚠ Background server requires attention'}
                      </li>
                      <li className="wizard-summary-ok">✓ Required offline readiness checks passed</li>
                    </ul>
                  </div>
                )}

                {(wizardPhase === 'done' || wizardPhase === 'error') && (
                  <div className="wizard-footer">
                    <button className="btn btn-primary" type="button" onClick={() => setWizardOpen(false)}>Close</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
