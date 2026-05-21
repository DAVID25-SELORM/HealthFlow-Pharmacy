import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Trash2, Plus, Minus, ShoppingCart, Printer, Download, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { dispatchHealthflowDataChanged } from '../lib/appEvents'
import { createSale, getRecentSales, getSaleById, refundSale } from '../services/salesService'
import { createClaim } from '../services/claimsService'
import { createNhisClaim } from '../services/nhisService'
import { getAllPatients } from '../services/patientService'
import { getPharmacySettings } from '../services/settingsService'
import { getBranches } from '../services/branchService'
import {
  createBranchSale,
  getBranchInventory,
  getBranchPosBootstrap,
  getBranchRecentSales,
  getBranchSale,
  getBranchServerConfig,
  getBranchServerHealth,
  getBranchSyncStatus,
  getNhiaSettings,
  initiateBranchPayment,
  isBranchServerEnabled,
  pullBranchInventory,
  pullBranchReferenceData,
  saveBranchServerConfig,
  searchBranchInventory,
  searchBranchPatients,
} from '../services/branchServerApi'
import { closeShift, getOpenShiftForUser, openShift } from '../services/shiftService'
import { printReceipt, downloadReceiptPDF, formatSaleForReceipt } from '../services/receiptService'
import {
  createOfflineSaleNumber,
  getOfflineSalesSummary,
  queueOfflineSale,
  subscribeOfflineSalesQueue,
  syncOfflineSales,
} from '../services/offlineSalesQueue'
import {
  filterCachedPatients,
  filterCachedDrugs,
  loadOfflinePosSnapshot,
  saveOfflinePosSnapshot,
} from '../services/offlinePosCache'
import { searchDrugs } from '../services/drugService'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { useTenant } from '../context/TenantContext'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { hasRole } from '../utils/roles'
import {
  normalizeNhiaMemberNumber,
  validateNhiaMemberNumberFormat,
} from '../utils/nhiaMemberNumber'
// ✅ NHIS PHARMACY LEVEL PATCH START
import {
  assessMedicinePharmacyLevel,
  getEffectivePharmacyLevel,
} from '../utils/nhisPharmacyLevel'
// ✅ NHIS PHARMACY LEVEL PATCH END
import Receipt from '../components/Receipt/Receipt'
import DiagnosisSelector from '../components/DiagnosisSelector/DiagnosisSelector'
import { getEffectiveSellingPrice, getNhisCatalogPrice, hasNhisCatalogPrice } from '../utils/drugPricing'
import './Sales.css'

const POS_DRUG_SEARCH_LIMIT = 30
const RECENT_SALES_LIMIT = 8
const POS_PATIENT_SEARCH_LIMIT = 8
const POS_BOOTSTRAP_PATIENT_LIMIT = 50
const POS_SEARCH_DEBOUNCE_MS = 180

const BRANCH_SYNC_LABELS = {
  patients: 'Patients',
  claims: 'Claims',
  nhis_drugs: 'NHIS Drugs',
  nhis_clinical_rules: 'NHIS Clinical Rules',
  nhis_claims: 'NHIS Claims',
  suppliers: 'Suppliers',
  purchases: 'Purchases',
  sales: 'Sales',
}

const formatPatientOption = (patient) =>
  [patient?.full_name, patient?.phone ? `(${patient.phone})` : null].filter(Boolean).join(' ')

const compactPatientLookup = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')

const formatAmountInput = (value) => Number(value || 0).toFixed(2)

const isNhisPatient = (patient) =>
  String(patient?.insurance_provider || '').trim().toLowerCase() === 'nhis'

const normalizeOrganizationType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'hospital' ? 'hospital' : 'pharmacy'
}

const getNhiaMemberNumber = (patient) =>
  patient?.insurance_id || patient?.nhis_member_no || patient?.nhis_hin || ''

const validateNhiaMemberNumber = validateNhiaMemberNumberFormat

const getNhisCoveredUnitPrice = (item) => {
  const retailPrice = Number.parseFloat(item?.price) || 0
  const nhisPrice = Number.parseFloat(item?.nhisPrice)
  return Number.isFinite(nhisPrice) && nhisPrice > 0
    ? Math.min(nhisPrice, retailPrice)
    : retailPrice
}

const splitPatientNameForNhis = (patient) => {
  const explicitSurname = String(patient?.surname || patient?.last_name || '').trim()
  const explicitOtherNames = String(patient?.other_names || patient?.first_name || '').trim()
  if (explicitSurname) {
    return { surname: explicitSurname, otherNames: explicitOtherNames }
  }

  const parts = String(patient?.full_name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) {
    return { surname: parts[0] || '', otherNames: '' }
  }

  return {
    surname: parts[parts.length - 1],
    otherNames: parts.slice(0, -1).join(' '),
  }
}

const mergePharmacySettingsWithOrganization = (settings, organization) => ({
  ...(settings || {}),
  pharmacy_name: settings?.pharmacy_name || organization?.name || 'HealthFlow Pharmacy',
  phone: settings?.phone || organization?.phone || null,
  email: settings?.email || organization?.email || null,
  address: settings?.address || organization?.address || null,
  city: settings?.city || organization?.city || null,
  region: settings?.region || organization?.region || null,
  logo_url: settings?.logo_url || organization?.logo_url || null,
  slogan: settings?.slogan || organization?.slogan || null,
  license_number: settings?.license_number || organization?.license_number || null,
  // ✅ NHIS PHARMACY LEVEL PATCH START
  pharmacy_level: settings?.pharmacy_level || organization?.pharmacy_level || null,
  // ✅ NHIS PHARMACY LEVEL PATCH END
})

const createLocalPosShift = ({ branchId, branch, openingCash = 0, userId } = {}) => {
  if (!branchId) {
    return null
  }

  return {
    id: `local-pos-${userId || 'staff'}-${branchId}`,
    branch_id: branchId,
    branches: branch || { id: branchId, name: 'Local branch' },
    opening_cash: openingCash,
    expected_cash: openingCash,
    status: 'open',
    isLocalPosShift: true,
  }
}

const mergeById = (primary = [], secondary = []) => {
  const rows = new Map()
  ;[...secondary, ...primary].forEach((row) => {
    if (row?.id) {
      rows.set(row.id, row)
    }
  })
  return [...rows.values()]
}

const Sales = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { user, displayName, role, profile, organization } = useAuth()
  const { notify } = useNotification()
  const { canUseNhisTopups } = useTenant()
  const isOnline = useOnlineStatus()
  const [drugs, setDrugs] = useState([])
  const [drugSearchLoading, setDrugSearchLoading] = useState(false)
  const [drugSearchMessage, setDrugSearchMessage] = useState('')
  const [patients, setPatients] = useState([])
  const [patientSearchLoading, setPatientSearchLoading] = useState(false)
  const [cart, setCart] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [patientId, setPatientId] = useState('')
  const [patientSearchTerm, setPatientSearchTerm] = useState('')
  const [isPatientSearchOpen, setIsPatientSearchOpen] = useState(false)
  const [highlightedPatientIndex, setHighlightedPatientIndex] = useState(0)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentProvider, setPaymentProvider] = useState('paystack')
  const [paymentPhone, setPaymentPhone] = useState('')
  const [paymentEmail, setPaymentEmail] = useState('')
  const [received, setReceived] = useState('')
  const [discountType, setDiscountType] = useState('amount')
  const [discountValue, setDiscountValue] = useState('')
  const [insuranceCoverage, setInsuranceCoverage] = useState('')
  const [patientTopUp, setPatientTopUp] = useState('')
  const [patientTopUpMethod, setPatientTopUpMethod] = useState('cash')
  const [nhiaDiagnosis, setNhiaDiagnosis] = useState('')
  const [nhiaDiagnosisDetails, setNhiaDiagnosisDetails] = useState([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [lastSale, setLastSale] = useState(null)
  const [showReceipt, setShowReceipt] = useState(false)
  const [pharmacyInfo, setPharmacyInfo] = useState(null)
  const [branches, setBranches] = useState([])
  const [activeShift, setActiveShift] = useState(null)
  const [shiftBranchId, setShiftBranchId] = useState('')
  const [openingCash, setOpeningCash] = useState('')
  const [countedCash, setCountedCash] = useState('')
  const [shiftNotes, setShiftNotes] = useState('')
  const [shiftBusy, setShiftBusy] = useState(false)
  const [recentSales, setRecentSales] = useState([])
  const [loadingRecentSales, setLoadingRecentSales] = useState(false)
  const [refundingSaleId, setRefundingSaleId] = useState(null)
  const [reprintingSaleId, setReprintingSaleId] = useState(null)
  const [offlineSalesSummary, setOfflineSalesSummary] = useState({
    pending: 0,
    syncing: 0,
    failed: 0,
    synced: 0,
    unsynced: 0,
    total: 0,
  })
  const [syncingOfflineSales, setSyncingOfflineSales] = useState(false)
  const [branchServerConfig, setBranchServerConfig] = useState(() => getBranchServerConfig())
  const [branchServerStatus, setBranchServerStatus] = useState({
    checked: false,
    online: false,
    message: 'Not checked',
    health: null,
  })
  const [nhiaSettings, setNhiaSettings] = useState(null)
  const [branchServerBusy, setBranchServerBusy] = useState(false)
  const [branchSyncStatus, setBranchSyncStatus] = useState(null)
  const canProcessRefund =
    hasRole(role, ['admin', 'pharmacist']) || Boolean(profile?.can_refund)
  const isAdmin = String(role || '').toLowerCase() === 'admin'
  const organizationType = normalizeOrganizationType(organization?.organization_type)
  const isHospital = organizationType === 'hospital'
  const activeBranches = branches.filter((branch) => branch.is_active !== false)
  const fallbackBranch =
    activeBranches.find((branch) => branch.is_main) || activeBranches[0] || null
  const assignedBranch = profile?.branch_id
    ? activeBranches.find((branch) => branch.id === profile.branch_id) || profile?.branches || null
    : !isAdmin && activeBranches.length === 1
      ? activeBranches[0]
      : null
  const effectiveBranchId = profile?.branch_id || assignedBranch?.id || shiftBranchId
  const canChooseShiftBranch = isAdmin && !profile?.branch_id && activeBranches.length > 1
  const unsyncedOfflineSales = Number(offlineSalesSummary.unsynced || 0)
  const branchServerModeEnabled = isBranchServerEnabled()
  const posAdminMode = isAdmin && searchParams.get('mode') === 'admin'
  const selectedPatientForSale = useMemo(
    () => patients.find((patient) => patient.id === patientId) || null,
    [patients, patientId]
  )
  const filteredPatients = useMemo(() => {
    const term = patientSearchTerm.trim().toLowerCase()
    const compactTerm = compactPatientLookup(term)
    const matches = term
      ? patients.filter((patient) =>
          [
            patient.full_name,
            patient.phone,
            patient.email,
            patient.insurance_provider,
            patient.insurance_id,
            patient.nhis_member_no,
            patient.nhis_hin,
          ]
            .filter(Boolean)
            .some((value) => {
              const normalizedValue = String(value).toLowerCase()
              return normalizedValue.includes(term) ||
                (compactTerm && compactPatientLookup(value).includes(compactTerm))
            })
        )
      : patients

    return matches.slice(0, POS_PATIENT_SEARCH_LIMIT)
  }, [patientSearchTerm, patients])

  useEffect(() => {
    let cancelled = false

    const fallbackPharmacyInfo = mergePharmacySettingsWithOrganization(null, organization)
    const profileBranch = profile?.branches || null

    const applySnapshot = (snapshot = {}) => {
      const cachedBranches = snapshot.branches?.length
        ? snapshot.branches
        : profileBranch
          ? [profileBranch]
          : []
      const cachedBranchId =
        snapshot.shiftBranchId ||
        snapshot.activeShift?.branch_id ||
        profile?.branch_id ||
        profileBranch?.id ||
        ''
      const cachedBranch =
        cachedBranches.find((branch) => branch.id === cachedBranchId) ||
        profileBranch ||
        null
      const cachedSnapshotShift =
        snapshot.activeShift?.isLocalPosShift && !branchServerModeEnabled
          ? null
          : snapshot.activeShift
      const cachedShift =
        cachedSnapshotShift ||
        (branchServerModeEnabled
          ? createLocalPosShift({
              branchId: cachedBranchId,
              branch: cachedBranch,
              userId: user?.id,
            })
          : null)

      setPatients(snapshot.patients || [])
      setPharmacyInfo(snapshot.pharmacyInfo || fallbackPharmacyInfo)
      setBranches(cachedBranches)
      setActiveShift(cachedShift)
      setShiftBranchId(cachedBranchId)
      setDrugs(snapshot.drugs || [])
      setRecentSales(snapshot.recentSales || [])
    }

    const loadData = async () => {
      let snapshot = null
      try {
        setLoading(true)
        setError('')

        snapshot = await loadOfflinePosSnapshot(user?.id)
        if (cancelled) return

        if (snapshot) {
          applySnapshot(snapshot)
          setLoading(false)
        } else if (branchServerModeEnabled) {
          applySnapshot({})
          setLoading(false)
        }

        if (branchServerModeEnabled) {
          try {
            const bootstrap = await getBranchPosBootstrap({
              inventoryLimit: POS_DRUG_SEARCH_LIMIT,
              patientLimit: POS_BOOTSTRAP_PATIENT_LIMIT,
              recentLimit: RECENT_SALES_LIMIT,
            })

            if (cancelled) {
              return
            }

            const branchId =
              profile?.branch_id ||
              snapshot?.shiftBranchId ||
              snapshot?.activeShift?.branch_id ||
              bootstrap.branchId ||
              profileBranch?.id ||
              ''
            const localBranch =
              profileBranch ||
              snapshot?.branches?.find((branch) => branch.id === branchId) ||
              (branchId ? { id: branchId, name: 'Local branch' } : null)
            const localShift =
              snapshot?.activeShift ||
              createLocalPosShift({
                branchId,
                branch: localBranch,
                userId: user?.id,
              })
            const nextBranches =
              snapshot?.branches?.length
                ? snapshot.branches
                : localBranch
                  ? [localBranch]
                  : []

            setPatients(bootstrap.patients || snapshot?.patients || [])
            setDrugs(bootstrap.inventory || snapshot?.drugs || [])
            setRecentSales(bootstrap.recentSales || snapshot?.recentSales || [])
            setBranches(nextBranches)
            setActiveShift(localShift)
            setShiftBranchId(branchId)
            setNhiaSettings(bootstrap.nhiaSettings || null)
            setBranchSyncStatus(bootstrap.sync || null)
            setError('')
            setLoading(false)
            void saveOfflinePosSnapshot(user?.id, {
              patients: bootstrap.patients || snapshot?.patients || [],
              drugs: bootstrap.inventory || snapshot?.drugs || [],
              recentSales: bootstrap.recentSales || snapshot?.recentSales || [],
              pharmacyInfo: snapshot?.pharmacyInfo || fallbackPharmacyInfo,
              branches: nextBranches,
              activeShift: localShift,
              shiftBranchId: branchId,
              organization,
              profile: {
                branch_id: profile?.branch_id || null,
                organization_id: profile?.organization_id || bootstrap.organizationId || null,
              },
              nhiaSettings: bootstrap.nhiaSettings || null,
            })

            getBranchInventory({ branchId, limit: 20000 })
              .then((fullInventory) =>
                saveOfflinePosSnapshot(user?.id, {
                  drugs: fullInventory || [],
                  drugsCacheMode: 'replace',
                  shiftBranchId: branchId,
                })
              )
              .catch((cacheError) => {
                console.warn('Unable to preload full local inventory cache:', cacheError)
              })
          } catch (branchError) {
            console.warn('Local POS bootstrap failed:', branchError)
            if (!snapshot && !cancelled) {
              setError(
                branchError.name === 'AbortError'
                  ? 'Local POS cache is not ready yet. Start the branch server or pull data from Admin mode.'
                  : branchError.message || 'Local branch server is unavailable.'
              )
              setLoading(false)
            }
          }
          return
        }

        if (!isSupabaseConfigured()) {
          if (!snapshot) {
            setError('Supabase is not configured. Update .env to enable sales.')
            setLoading(false)
          }
          return
        }

        const [patientsData, pharmacySettings, branchesData, openShiftData] = await Promise.all([
          getAllPatients(),
          getPharmacySettings().catch(() => null),
          getBranches(),
          getOpenShiftForUser(user?.id),
        ])
        if (cancelled) return

        const mergedPharmacyInfo = mergePharmacySettingsWithOrganization(pharmacySettings, organization)
        const nextShiftBranchId =
          openShiftData?.branch_id ||
          profile?.branch_id ||
          branchesData.find((branch) => branch.is_active !== false && branch.is_main)?.id ||
          branchesData.find((branch) => branch.is_active !== false)?.id ||
          ''

        setPatients(patientsData)
        setPharmacyInfo(mergedPharmacyInfo)
        setBranches(branchesData)
        setActiveShift(openShiftData)
        setShiftBranchId(nextShiftBranchId)
        void saveOfflinePosSnapshot(user?.id, {
          patients: patientsData,
          pharmacyInfo: mergedPharmacyInfo,
          branches: branchesData,
          activeShift: openShiftData,
          shiftBranchId: nextShiftBranchId,
          organization,
          profile: {
            branch_id: profile?.branch_id || null,
            organization_id: profile?.organization_id || null,
          },
        })
        setLoading(false)

        getRecentSales(RECENT_SALES_LIMIT)
          .then((recent) => {
            if (!cancelled) {
              setRecentSales(recent || [])
            }
          })
          .catch((recentError) => {
            console.error('Failed to load recent sales:', recentError)
          })
      } catch (loadError) {
        console.error('Error loading POS data:', loadError)
        if (snapshot && !cancelled) {
          applySnapshot(snapshot)
          setError('')
          setLoading(false)
          return
        }
        setError(loadError.message || 'Unable to load POS data.')
        setLoading(false)
      }
    }

    loadData()

    return () => {
      cancelled = true
    }
  }, [
    branchServerModeEnabled,
    canProcessRefund,
    isOnline,
    organization,
    profile?.branch_id,
    profile?.branches,
    profile?.organization_id,
    role,
    user?.id,
  ])

  useEffect(() => {
    setHighlightedPatientIndex(0)
  }, [patientSearchTerm])

  useEffect(() => {
    if (loading) {
      return undefined
    }

    let cancelled = false
    const term = patientSearchTerm.trim()

    const searchPatientsLocally = async () => {
      try {
        if (branchServerModeEnabled) {
          setPatientSearchLoading(true)
          const localPatients = await searchBranchPatients({
            term,
            limit: term ? POS_PATIENT_SEARCH_LIMIT : POS_BOOTSTRAP_PATIENT_LIMIT,
          })

          if (cancelled) {
            return
          }

          setPatients((current) => mergeById(localPatients, current))
          void saveOfflinePosSnapshot(user?.id, {
            patients: term ? mergeById(localPatients, patients) : localPatients,
          })
          return
        }

        const snapshot = await loadOfflinePosSnapshot(user?.id)
        const cachedPatients = filterCachedPatients(
          snapshot?.patients?.length ? snapshot.patients : patients,
          term,
          term ? POS_PATIENT_SEARCH_LIMIT : POS_BOOTSTRAP_PATIENT_LIMIT
        )

        if (!cancelled && cachedPatients.length) {
          setPatients((current) => mergeById(cachedPatients, current))
        }
      } catch (patientSearchError) {
        console.warn('Local patient search failed:', patientSearchError)
      } finally {
        if (!cancelled) {
          setPatientSearchLoading(false)
        }
      }
    }

    const timeout = window.setTimeout(
      searchPatientsLocally,
      term ? POS_SEARCH_DEBOUNCE_MS : 0
    )

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [branchServerModeEnabled, loading, patientSearchTerm, user?.id])

  useEffect(() => {
    if (!branchServerModeEnabled) {
      setNhiaSettings(null)
      return
    }

    let cancelled = false
    getNhiaSettings()
      .then((settings) => {
        if (!cancelled) {
          setNhiaSettings(settings)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNhiaSettings(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [branchServerModeEnabled])

  useEffect(() => {
    if (loading) {
      return undefined
    }

    let cancelled = false
    const term = searchTerm.trim()

    const searchInventory = async () => {
      try {
        setDrugSearchLoading(true)
        setDrugSearchMessage('')

        if (branchServerModeEnabled) {
          try {
            const localResults = await searchBranchInventory({
              term,
              limit: POS_DRUG_SEARCH_LIMIT,
            })

            if (cancelled) {
              return
            }

            setDrugs(localResults)
            void saveOfflinePosSnapshot(user?.id, { drugs: localResults })
            setDrugSearchMessage(
              localResults.length
                ? 'Showing local branch inventory.'
                : 'No matching in-stock drugs found in the local branch server.'
            )
            return
          } catch (branchSearchError) {
            console.warn('Local branch inventory search failed:', branchSearchError)
            setDrugSearchMessage('Local branch inventory is unavailable. Showing cached stock.')
          }
        }

        if (isSupabaseConfigured()) {
          try {
            const hostedResults = await searchDrugs(term, {
              useTierAccess: true,
              inStockOnly: true,
              limit: POS_DRUG_SEARCH_LIMIT,
              branchId: effectiveBranchId || undefined,
            })

            if (cancelled) {
              return
            }

            setDrugs(hostedResults)
            void saveOfflinePosSnapshot(user?.id, { drugs: hostedResults })
            setDrugSearchMessage(
              hostedResults.length
                ? 'Showing live inventory.'
                : 'No matching in-stock drugs found.'
            )
            return
          } catch (hostedSearchError) {
            console.warn('Hosted inventory search failed:', hostedSearchError)
            setDrugSearchMessage('Live inventory is unavailable. Showing cached stock.')
          }
        }

        const snapshot = await loadOfflinePosSnapshot(user?.id)
        const cachedResults = filterCachedDrugs(
          snapshot?.drugs?.length ? snapshot.drugs : drugs,
          term,
          POS_DRUG_SEARCH_LIMIT
        )

        if (cancelled) {
          return
        }

        setDrugs(cachedResults)
        setDrugSearchMessage(
          cachedResults.length
            ? 'Showing cached local inventory.'
            : branchServerModeEnabled
              ? 'No cached in-stock drugs found. Pull inventory from Admin mode.'
              : 'No cached in-stock drugs found.'
        )
      } catch (searchError) {
        if (!cancelled) {
          console.error('Failed to search inventory:', searchError)
          setDrugs([])
          setDrugSearchMessage(searchError.message || 'Unable to search inventory.')
        }
      } finally {
        if (!cancelled) {
          setDrugSearchLoading(false)
        }
      }
    }

    const timeout = window.setTimeout(searchInventory, term ? POS_SEARCH_DEBOUNCE_MS : 0)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [branchServerModeEnabled, effectiveBranchId, loading, searchTerm, user?.id])

  useEffect(() => {
    const routeSearch = searchParams.get('search') || ''
    setSearchTerm((current) => (current === routeSearch ? current : routeSearch))
  }, [searchParams])

  const syncSearchParam = (value) => {
    const params = new URLSearchParams(searchParams)
    const normalizedValue = value.trim()

    if (normalizedValue) {
      params.set('search', normalizedValue)
    } else {
      params.delete('search')
    }

    setSearchParams(params, { replace: true })
  }

  const handleSearchChange = (value) => {
    setSearchTerm(value)
    syncSearchParam(value)
  }

  const selectPatientForSale = (patient) => {
    if (!patient) {
      setPatientId('')
      setPatientSearchTerm('')
      setPaymentPhone('')
      setPaymentEmail('')
      setIsPatientSearchOpen(false)
      return
    }

    setPatientId(patient.id)
    setPatientSearchTerm(formatPatientOption(patient))
    setPaymentPhone((current) => current || patient.phone || '')
    setPaymentEmail((current) => current || patient.email || '')
    setIsPatientSearchOpen(false)
  }

  const handlePatientSearchChange = (value) => {
    setPatientSearchTerm(value)
    setPatientId('')
    setIsPatientSearchOpen(true)
  }

  const handlePatientSearchKeyDown = (event) => {
    if (event.key === 'Escape') {
      setIsPatientSearchOpen(false)
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIsPatientSearchOpen(true)
      setHighlightedPatientIndex((current) =>
        Math.min(current + 1, Math.max(filteredPatients.length - 1, 0))
      )
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedPatientIndex((current) => Math.max(current - 1, 0))
      return
    }

    if (event.key === 'Enter' && isPatientSearchOpen) {
      event.preventDefault()
      selectPatientForSale(filteredPatients[highlightedPatientIndex] || null)
    }
  }

  const cartCount = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  )

  const calculateSubtotal = () => {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
  }

  const calculateSaleDiscount = () => {
    const subtotal = calculateSubtotal()
    const value = Number.parseFloat(discountValue) || 0
    if (value <= 0 || subtotal <= 0) {
      return 0
    }
    if (discountType === 'percent') {
      return Math.min(subtotal, (subtotal * value) / 100)
    }
    return Math.min(subtotal, value)
  }

  const calculateTotal = () => {
    return Math.max(0, calculateSubtotal() - calculateSaleDiscount())
  }

  const calculateNhisCoveredTotal = () => {
    return cart.reduce((sum, item) => {
      return sum + getNhisCoveredUnitPrice(item) * item.quantity
    }, 0)
  }

  const calculateChange = () => {
    const total = calculateTotal()
    const receivedAmount = Number.parseFloat(received) || 0
    return Math.max(0, receivedAmount - total)
  }

  const getReservedQty = (drugId) => {
    const row = cart.find((item) => item.id === drugId)
    return row?.quantity || 0
  }

  // ✅ NHIS PHARMACY LEVEL PATCH START
  const getFacilityPharmacyLevel = () =>
    getEffectivePharmacyLevel(pharmacyInfo, organization, nhiaSettings)

  const validateDrugForFacilityLevel = (drug) => {
    const check = assessMedicinePharmacyLevel(drug, getFacilityPharmacyLevel())
    if (!check.allowed) {
      notify(check.message, 'warning')
      return false
    }
    if (check.message === 'Level not configured') {
      notify('Level not configured', 'warning')
    }
    return true
  }
  // ✅ NHIS PHARMACY LEVEL PATCH END

  const addToCart = (drug) => {
    // ✅ NHIS PHARMACY LEVEL PATCH START
    if (!validateDrugForFacilityLevel(drug)) {
      return
    }
    // ✅ NHIS PHARMACY LEVEL PATCH END

    setCart((current) => {
      const existing = current.find((item) => item.id === drug.id)
      const maxQty = Number.parseFloat(drug.quantity) || 0

      if (existing) {
        if (existing.quantity >= maxQty) {
          return current
        }
        return current.map((item) =>
          item.id === drug.id ? { ...item, quantity: item.quantity + 1 } : item
        )
      }

      if (maxQty <= 0) {
        return current
      }

      const retailPrice = getEffectiveSellingPrice(drug)
      const nhisPrice = getNhisCatalogPrice(drug)

      return [
        ...current,
        {
          id: drug.id,
          drugId: drug.id,
          name: drug.name,
          price: retailPrice,
          nhisPrice: nhisPrice > 0 ? nhisPrice : null,
          nhisCode: nhisPrice > 0 ? drug.nhis_code || null : null,
          genericName: drug.generic_name || null,
          unit: drug.unit || 'unit',
          // ✅ NHIS PHARMACY LEVEL PATCH START
          medicineAccessLevel: drug.medicine_access_level || drug.medicineAccessLevel || null,
          requiredPharmacyLevel: drug.required_pharmacy_level || drug.requiredPharmacyLevel || null,
          // ✅ NHIS PHARMACY LEVEL PATCH END
          quantity: 1,
          available: maxQty,
        },
      ]
    })
  }

  const updateQuantity = (id, change) => {
    setCart((current) =>
      current
        .map((item) => {
          if (item.id !== id) {
            return item
          }
          const nextQty = item.quantity + change
          if (nextQty <= 0) {
            return null
          }
          if (nextQty > item.available) {
            return item
          }
          return { ...item, quantity: nextQty }
        })
        .filter(Boolean)
    )
  }

  const setItemQuantity = (id, rawValue, available) => {
    const value = parseInt(rawValue, 10)
    if (Number.isNaN(value) || value <= 0) {
      setCart((current) => current.filter((item) => item.id !== id))
      return
    }
    const clamped = Math.min(value, available)
    setCart((current) =>
      current.map((item) => (item.id === id ? { ...item, quantity: clamped } : item))
    )
  }

  const removeItem = (id) => {
    setCart((current) => current.filter((item) => item.id !== id))
  }

  const refreshDrugs = async () => {
    try {
      if (branchServerModeEnabled) {
        const latestLocalDrugs = await searchBranchInventory({
          term: searchTerm,
          limit: POS_DRUG_SEARCH_LIMIT,
        })
        setDrugs(latestLocalDrugs)
        void saveOfflinePosSnapshot(user?.id, { drugs: latestLocalDrugs })
        return
      }

      if (isSupabaseConfigured()) {
        const latestHostedDrugs = await searchDrugs(searchTerm, {
          useTierAccess: true,
          inStockOnly: true,
          limit: POS_DRUG_SEARCH_LIMIT,
          branchId: effectiveBranchId || undefined,
        })
        setDrugs(latestHostedDrugs)
        void saveOfflinePosSnapshot(user?.id, { drugs: latestHostedDrugs })
        return
      }

      const snapshot = await loadOfflinePosSnapshot(user?.id)
      setDrugs(filterCachedDrugs(snapshot?.drugs || drugs, searchTerm, POS_DRUG_SEARCH_LIMIT))
    } catch (refreshError) {
      console.error('Failed to refresh inventory:', refreshError)
    }
  }

  const reduceSoldDrugQuantities = (soldItems) => {
    const soldQuantityByDrugId = new Map(
      soldItems.map((item) => [item.drugId, item.quantity])
    )

    const applySoldQuantities = (drugList = []) =>
      drugList.map((drug) => {
        const soldQuantity = soldQuantityByDrugId.get(drug.id)
        if (!soldQuantity) {
          return drug
        }

        const currentQuantity = Number.parseFloat(drug.quantity ?? 0) || 0
        return {
          ...drug,
          quantity: Math.max(0, currentQuantity - soldQuantity),
        }
      })

    setDrugs((currentDrugs) => {
      const updatedDrugs = applySoldQuantities(currentDrugs)
      void loadOfflinePosSnapshot(user?.id)
        .then((snapshot) =>
          saveOfflinePosSnapshot(user?.id, {
            drugs: applySoldQuantities(snapshot?.drugs?.length ? snapshot.drugs : updatedDrugs),
          })
        )
        .catch((cacheError) => {
          console.warn('Unable to update offline inventory cache:', cacheError)
        })
      return updatedDrugs
    })
  }

  const refreshRecentSales = async () => {
    try {
      setLoadingRecentSales(true)
      const recent = branchServerModeEnabled
        ? await getBranchRecentSales(RECENT_SALES_LIMIT)
        : await getRecentSales(RECENT_SALES_LIMIT)
      setRecentSales(recent || [])
      void saveOfflinePosSnapshot(user?.id, { recentSales: recent || [] })
    } catch (refreshError) {
      console.error('Failed to refresh recent sales:', refreshError)
    } finally {
      setLoadingRecentSales(false)
    }
  }

  const refreshOfflineSalesSummary = useCallback(async () => {
    const summary = await getOfflineSalesSummary()
    setOfflineSalesSummary(summary)
  }, [])

  const syncPendingOfflineSales = useCallback(
    async ({ silent = false } = {}) => {
      if (!isOnline) {
        if (!silent) {
          notify('Offline sales will sync when the internet connection returns.', 'info')
        }
        return
      }

      try {
        setSyncingOfflineSales(true)
        const result = await syncOfflineSales()
        await refreshOfflineSalesSummary()

        if (result.synced > 0) {
          if (!silent) {
            notify(`${result.synced} offline sale${result.synced === 1 ? '' : 's'} synced.`, 'success')
          }

          void Promise.all([refreshRecentSales(), refreshDrugs()]).finally(() => {
            dispatchHealthflowDataChanged()
          })
        }

        if (result.failed > 0 && !silent) {
          notify(
            `${result.failed} offline sale${result.failed === 1 ? '' : 's'} could not sync. Keep the shift open and try again.`,
            'warning'
          )
        }
      } catch (syncError) {
        console.error('Unable to sync offline sales:', syncError)
        if (!silent) {
          notify(syncError.message || 'Unable to sync offline sales.', 'error')
        }
      } finally {
        setSyncingOfflineSales(false)
      }
    },
    [effectiveBranchId, isOnline, notify, refreshOfflineSalesSummary, searchTerm, user?.id]
  )
  const selectedNhiaMemberNumber = getNhiaMemberNumber(selectedPatientForSale)

  useEffect(() => {
    void refreshOfflineSalesSummary()
    return subscribeOfflineSalesQueue(() => {
      void refreshOfflineSalesSummary()
    })
  }, [refreshOfflineSalesSummary])

  useEffect(() => {
    if (isOnline && offlineSalesSummary.pending > 0 && !syncingOfflineSales) {
      void syncPendingOfflineSales({ silent: true })
    }
  }, [isOnline, offlineSalesSummary.pending, syncingOfflineSales, syncPendingOfflineSales])

  const refreshBranchServerStatus = useCallback(async () => {
    const config = getBranchServerConfig()
    setBranchServerConfig(config)

    if (!config.enabled || !config.token) {
      setBranchServerStatus({
        checked: true,
        online: false,
        message: 'Not configured',
        health: null,
      })
      setBranchSyncStatus(null)
      return
    }

    try {
      const [health, syncStatus] = await Promise.all([
        getBranchServerHealth(),
        getBranchSyncStatus(),
      ])
      setBranchServerStatus({
        checked: true,
        online: true,
        message: 'Connected',
        health,
      })
      setBranchSyncStatus(syncStatus)
    } catch (statusError) {
      setBranchServerStatus({
        checked: true,
        online: false,
        message: statusError.message || 'Unavailable',
        health: null,
      })
      setBranchSyncStatus(null)
    }
  }, [])

  useEffect(() => {
    void refreshBranchServerStatus()
    const interval = window.setInterval(() => {
      void refreshBranchServerStatus()
    }, 30000)

    return () => window.clearInterval(interval)
  }, [refreshBranchServerStatus])

  const configureBranchServer = async () => {
    if (!isAdmin) {
      notify('Only admins can configure the local branch server.', 'warning')
      return
    }

    const currentConfig = getBranchServerConfig()
    const url = window.prompt('Local branch server URL:', currentConfig.url || 'http://localhost:4780')
    if (url === null) {
      return
    }

    const token = window.prompt('Local branch server token:', currentConfig.token || '')
    if (token === null) {
      return
    }

    const nextConfig = saveBranchServerConfig({
      enabled: true,
      url: url.trim() || 'http://localhost:4780',
      token: token.trim(),
    })
    setBranchServerConfig(nextConfig)
    await refreshBranchServerStatus()
    notify('Local branch server settings saved for this browser.', 'success')
  }

  const pullInventoryToBranchServer = async () => {
    if (!isAdmin) {
      notify('Only admins can pull inventory into the local branch server.', 'warning')
      return
    }

    try {
      setBranchServerBusy(true)
      const [result, referenceResult] = await Promise.all([
        pullBranchInventory(),
        pullBranchReferenceData(),
      ])
      const fullInventory = await getBranchInventory({
        branchId: effectiveBranchId || fallbackBranch?.id || '',
        limit: 20000,
      })
      await saveOfflinePosSnapshot(user?.id, {
        drugs: fullInventory || [],
        drugsCacheMode: 'replace',
        shiftBranchId: effectiveBranchId || fallbackBranch?.id || '',
      })
      await refreshBranchServerStatus()
      notify(
        `Updated local cache: ${result.imported || 0} inventory item${result.imported === 1 ? '' : 's'}, ${referenceResult.patients || 0} patient${referenceResult.patients === 1 ? '' : 's'}, and NHIA references.`,
        'success'
      )
    } catch (pullError) {
      notify(pullError.message || 'Unable to pull branch inventory.', 'error')
    } finally {
      setBranchServerBusy(false)
    }
  }

  const branchRecordSyncEntries = Object.entries(branchSyncStatus?.recordsByEntity || {})
  const branchEventSyncEntries = Object.entries(branchSyncStatus?.eventsByType || {})

  const setSalesMode = (mode) => {
    const params = new URLSearchParams(searchParams)
    if (mode === 'admin') {
      params.set('mode', 'admin')
    } else {
      params.delete('mode')
    }
    setSearchParams(params, { replace: true })
  }

  const handlePaymentMethodChange = (method) => {
    setPaymentMethod(method)
    if (method === 'card') {
      setPaymentProvider('paystack')
    }

    if (method !== 'cash') {
      setReceived('')
    }

    if (method !== 'insurance' && method !== 'nhia') {
      setInsuranceCoverage('')
      setPatientTopUp('')
      setPatientTopUpMethod('cash')
      setNhiaDiagnosis('')
      setNhiaDiagnosisDetails([])
      return
    }

    const total = calculateTotal()
    const shouldUseNhisTopUpPricing =
      method !== 'nhia' && isNhisPatient(selectedPatientForSale) && canUseNhisTopups
    const coveredAmount =
      method === 'nhia'
        ? Math.min(calculateNhisCoveredTotal(), total)
        : shouldUseNhisTopUpPricing
          ? calculateNhisCoveredTotal()
          : total
    setInsuranceCoverage(formatAmountInput(Math.min(coveredAmount, total)))
    setPatientTopUp(
      shouldUseNhisTopUpPricing ? formatAmountInput(Math.max(total - coveredAmount, 0)) : '0.00'
    )
    setPatientTopUpMethod('cash')
  }

  const handleInsuranceCoverageChange = (value) => {
    const total = calculateTotal()
    const coverage = Math.min(Math.max(Number.parseFloat(value) || 0, 0), total)
    setInsuranceCoverage(value)
    if (servingNhisPatient && !canUseNhisTopups) {
      setPatientTopUp('0.00')
      return
    }
    setPatientTopUp(formatAmountInput(Math.max(total - coverage, 0)))
  }

  const handlePatientTopUpChange = (value) => {
    if (servingNhisPatient && !canUseNhisTopups) {
      setPatientTopUp('0.00')
      setInsuranceCoverage(formatAmountInput(calculateTotal()))
      return
    }

    const total = calculateTotal()
    const topUp = Math.min(Math.max(Number.parseFloat(value) || 0, 0), total)
    setPatientTopUp(value)
    setInsuranceCoverage(formatAmountInput(Math.max(total - topUp, 0)))
  }

  const buildInsuranceSaleNotes = ({
    saleNumber,
    total,
    coverage,
    topUp,
    topUpMethod,
    retailTotal = total,
    pricingAdjustment = 0,
  }) =>
    [
      `Insurance sale ${saleNumber || ''}`.trim(),
      `Provider: ${selectedPatientForSale?.insurance_provider}`,
      `Insurance ID: ${selectedPatientForSale?.insurance_id}`,
      retailTotal !== total ? `Retail total: GHS ${retailTotal.toFixed(2)}` : null,
      `Insurance covered: GHS ${coverage.toFixed(2)}`,
      pricingAdjustment > 0 ? `NHIS pricing adjustment: GHS ${pricingAdjustment.toFixed(2)}` : null,
      `Patient top-up: GHS ${topUp.toFixed(2)}`,
      topUp > 0 ? `Top-up method: ${topUpMethod.toUpperCase()}` : null,
    ]
      .filter(Boolean)
      .join('\n')

  const buildInsuranceClaimItems = (soldItems, coverage, total) => {
    const grossTotal = soldItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
    const netScale = grossTotal > 0 ? total / grossTotal : 0
    const scale = total > 0 ? coverage / total : 0
    return soldItems.map((item) => ({
      ...item,
      price: item.price * netScale * Math.min(scale, 1),
    }))
  }

  const buildInsuranceClaimPayload = ({
    saleNumber,
    soldItems,
    total,
    coverage,
    topUp,
    topUpMethod,
    branchId,
    saleDate,
  }) => {
    if (paymentMethod !== 'insurance' || coverage <= 0) {
      return null
    }

    const claimItems = buildInsuranceClaimItems(soldItems, coverage, total)
    return {
      patientId: selectedPatientForSale.id,
      patientName: selectedPatientForSale.full_name,
      insuranceProvider: selectedPatientForSale.insurance_provider,
      insuranceId: selectedPatientForSale.insurance_id,
      serviceDate: (saleDate || new Date().toISOString()).split('T')[0],
      notes: [
        saleNumber
          ? `Auto-created from POS sale ${saleNumber}.`
          : 'Auto-created from local branch POS sale.',
        coverage < total - 0.01
          ? 'Claim item values were prorated to match the insurance-covered amount.'
          : null,
        `Sale total: GHS ${total.toFixed(2)}`,
        `Insurance covered: GHS ${coverage.toFixed(2)}`,
        `Patient top-up: GHS ${topUp.toFixed(2)}`,
        topUp > 0 ? `Top-up method: ${topUpMethod.toUpperCase()}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      items: claimItems,
      submittedBy: user?.id || null,
      branchId,
    }
  }

  const buildNhiaReviewClaim = ({
    saleNumber,
    soldItems,
    retailTotal,
    claimTotal,
    pricingAdjustment,
    branchId,
    saleDate,
  }) => {
    if (paymentMethod !== 'nhia') {
      return null
    }

    const serviceDate = (saleDate || new Date().toISOString()).split('T')[0]
    const { surname, otherNames } = splitPatientNameForNhis(selectedPatientForSale)
    const medicines = soldItems.map((item) => {
      const unitPrice = getNhisCoveredUnitPrice(item)
      const totalAmount = Number((unitPrice * item.quantity).toFixed(2))
      return {
        nhisDrugId: null,
        drugCode: item.nhisCode || '',
        description: item.genericName || item.name,
        unit: item.unit || 'unit',
        unitPrice,
        dispensedQty: item.quantity,
        dispensaryDate: serviceDate,
        dose: '',
        frequency: '',
        duration: '',
        totalAmount,
        // ✅ NHIS PHARMACY LEVEL PATCH START
        medicineAccessLevel: item.medicineAccessLevel || null,
        requiredPharmacyLevel: item.requiredPharmacyLevel || null,
        // ✅ NHIS PHARMACY LEVEL PATCH END
      }
    })

    return {
      claimData: {
        patientId: selectedPatientForSale.id,
        memberNo: normalizeNhiaMemberNumber(selectedNhiaMemberNumber),
        hin: selectedPatientForSale.nhis_hin || null,
        surname,
        otherNames,
        folderNo: selectedPatientForSale.folder_no || '',
        gender: selectedPatientForSale.gender || '',
        dateOfBirth: selectedPatientForSale.date_of_birth || '',
        patientAddress: selectedPatientForSale.address || '',
        cccNo: '',
        diagnosis: isHospital ? nhiaDiagnosis.trim() : '',
        diagnosisDetails: isHospital ? nhiaDiagnosisDetails : [],
        serviceDate,
        referringFacility: '',
        referralCode: '',
        physicianName: '',
        preAuthCodes: '',
        organizationType,
        branchId,
        createdBy: user?.id || null,
        allowIncompleteReview: true,
        notes: [
          saleNumber
            ? `Auto-created from POS NHIA sale ${saleNumber}.`
            : 'Auto-created from POS NHIA sale.',
          'Pending claims officer review before CLAIM-it submission.',
          `Retail sale total: GHS ${retailTotal.toFixed(2)}`,
          `NHIS covered amount: GHS ${claimTotal.toFixed(2)}`,
          pricingAdjustment > 0
            ? `NHIS pricing adjustment: GHS ${pricingAdjustment.toFixed(2)}`
            : null,
        ].filter(Boolean).join('\n'),
      },
      medicines,
    }
  }

  const createInsuranceClaimForSale = async (claimArgs) => {
    const claimPayload = buildInsuranceClaimPayload(claimArgs)
    return claimPayload ? await createClaim(claimPayload) : null
  }

  const handleCompleteSale = async () => {
    if (!cart.length) {
      return
    }

    if (!activeShift?.id) {
      notify('Open a shift before completing sales.', 'warning')
      return
    }

    const subtotal = calculateSubtotal()
    const saleDiscount = calculateSaleDiscount()
    const retailNetTotal = calculateTotal()
    const amountPaid = Number.parseFloat(received) || 0
    const saleIsNhiaClaim = paymentMethod === 'nhia'
    const saleUsesOnlineProvider = paymentMethod === 'momo' || paymentMethod === 'card'
    const nhiaCoveredAmount = saleIsNhiaClaim
      ? Math.min(calculateNhisCoveredTotal(), retailNetTotal)
      : retailNetTotal
    const nhiaPricingAdjustment = saleIsNhiaClaim
      ? Math.max(retailNetTotal - nhiaCoveredAmount, 0)
      : 0
    const total = saleIsNhiaClaim ? nhiaCoveredAmount : retailNetTotal
    const recordedSaleDiscount = saleDiscount + nhiaPricingAdjustment
    const saleIsInsuranceLike = paymentMethod === 'insurance' || saleIsNhiaClaim
    const insuranceSplitAllowed = !saleIsNhiaClaim && (!servingNhisPatient || canUseNhisTopups)
    const insuranceCoveredAmount =
      saleIsNhiaClaim
        ? total
        : paymentMethod === 'insurance' && !insuranceSplitAllowed
        ? total
        : Number.parseFloat(insuranceCoverage) || 0
    const patientTopUpAmount =
      saleIsNhiaClaim || (paymentMethod === 'insurance' && !insuranceSplitAllowed)
        ? 0
        : Number.parseFloat(patientTopUp) || 0

    if (paymentMethod === 'cash' && amountPaid < total) {
      notify('Received amount must be at least the total for cash payments.', 'warning')
      return
    }

    if (saleUsesOnlineProvider) {
      if (!isOnline) {
        notify('Mobile Money and Card payments require internet. Use Cash while offline.', 'warning')
        return
      }

      if (!branchServerModeEnabled || !branchServerStatus.online) {
        notify('Connect the local branch server before taking Mobile Money or Card payments.', 'warning')
        return
      }

      if (paymentProvider === 'hubtel' && !paymentPhone.trim()) {
        notify('Enter the customer mobile number for Hubtel payment.', 'warning')
        return
      }
    }

    if (saleIsInsuranceLike) {
      if (!selectedPatientForSale) {
        notify('Select a patient before completing an insurance/NHIA sale.', 'warning')
        return
      }

      const memberNumber = saleIsNhiaClaim ? selectedNhiaMemberNumber : selectedPatientForSale.insurance_id
      if (!selectedPatientForSale.insurance_provider || !memberNumber) {
        notify('The selected patient does not have insurance details on file.', 'warning')
        return
      }

      if (saleIsNhiaClaim) {
        const memberNumberError = validateNhiaMemberNumber(selectedNhiaMemberNumber, nhiaSettings || {})
        if (memberNumberError) {
          notify(memberNumberError, 'warning')
          return
        }

        if (isHospital && !nhiaDiagnosis.trim()) {
          notify('Enter the NHIA diagnosis before saving this claim sale.', 'warning')
          return
        }
      }

      if (insuranceCoveredAmount <= 0) {
        notify('Enter how much the insurance is covering.', 'warning')
        return
      }

      if (Math.abs(insuranceCoveredAmount + patientTopUpAmount - total) > 0.01) {
        notify('Insurance cover and patient top-up must add up to the sale total.', 'warning')
        return
      }

      if (saleIsNhiaClaim && !branchServerModeEnabled) {
        notify('NHIA claim sales must be saved through the local branch server.', 'warning')
        return
      }
    }

    try {
      setProcessing(true)
      setError('')
      const saleTimestamp = new Date().toISOString()
      const soldItems = cart.map((item) => ({
        drugId: item.drugId,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        nhisCode: item.nhisCode || null,
        nhisPrice: item.nhisPrice || null,
        genericName: item.genericName || null,
        unit: item.unit || 'unit',
        // ✅ NHIS PHARMACY LEVEL PATCH START
        medicineAccessLevel: item.medicineAccessLevel || null,
        requiredPharmacyLevel: item.requiredPharmacyLevel || null,
        // ✅ NHIS PHARMACY LEVEL PATCH END
      }))

      const salePayload = {
        items: soldItems,
        patientId: patientId || null,
        paymentMethod,
        discount: recordedSaleDiscount,
        amountPaid: paymentMethod === 'cash' ? amountPaid : total,
        change: paymentMethod === 'cash' ? calculateChange() : 0,
        notes:
          saleIsInsuranceLike
            ? buildInsuranceSaleNotes({
                total,
                coverage: insuranceCoveredAmount,
                topUp: patientTopUpAmount,
                topUpMethod: patientTopUpMethod,
                retailTotal: retailNetTotal,
                pricingAdjustment: nhiaPricingAdjustment,
              })
            : null,
        insuranceCoveredAmount:
          saleIsInsuranceLike ? insuranceCoveredAmount : null,
        insuranceTopUpAmount:
          saleIsInsuranceLike ? patientTopUpAmount : null,
        insuranceTopUpPaymentMethod:
          saleIsInsuranceLike && patientTopUpAmount > 0 ? patientTopUpMethod : null,
        soldBy: user?.id || null,
        shiftId: activeShift.isLocalPosShift ? null : activeShift.id,
        organizationId: profile?.organization_id,
        branchId: activeShift.branch_id,
        saleDate: saleTimestamp,
      }

      const buildReceiptData = (saleNumber) => ({
        saleNumber,
        saleDate: saleTimestamp,
        items: cart.map((item) => ({
          drug_name: item.name,
          quantity: item.quantity,
          unit_price: item.price,
          total_price: item.quantity * item.price,
        })),
        totalAmount: subtotal,
        discount: recordedSaleDiscount,
        netAmount: total,
        paymentMethod: paymentMethod,
        amountPaid: paymentMethod === 'cash' ? amountPaid : total,
        change: paymentMethod === 'cash' ? calculateChange() : 0,
        patient: selectedPatientForSale,
        insuranceDetails:
          saleIsInsuranceLike
            ? {
                provider: selectedPatientForSale.insurance_provider,
                insuranceId: selectedPatientForSale.insurance_id,
                coveredAmount: insuranceCoveredAmount,
                patientTopUp: patientTopUpAmount,
                patientTopUpMethod: patientTopUpAmount > 0 ? patientTopUpMethod : null,
              }
            : null,
        soldBy: displayName || user?.email,
      })

      if (saleUsesOnlineProvider) {
        const paymentResult = await initiateBranchPayment({
          provider: paymentProvider,
          paymentMethod,
          salePayload,
          customerPhone: paymentPhone,
          customerEmail: paymentEmail,
          returnUrl: window.location.href,
        })

        if (paymentResult?.authorizationUrl) {
          window.open(paymentResult.authorizationUrl, '_blank', 'noopener,noreferrer')
        }

        const receiptData = buildReceiptData(paymentResult?.saleNumber || paymentResult?.sale?.saleNumber)
        setLastSale({
          ...receiptData,
          offline: true,
          branchServer: true,
          paymentStatus: 'pending_payment',
          paymentReference: paymentResult?.reference,
        })
        reduceSoldDrugQuantities(soldItems)
        setCart([])
        setSearchTerm('')
        syncSearchParam('')
        setReceived('')
        setDiscountType('amount')
        setDiscountValue('')
        setInsuranceCoverage('')
        setPatientTopUp('')
        setPatientTopUpMethod('cash')
        setNhiaDiagnosis('')
        setNhiaDiagnosisDetails([])
        setPaymentPhone('')
        setPaymentEmail('')
        selectPatientForSale(null)
        notify(
          `Payment started. Reference ${paymentResult?.reference || ''}. The sale will sync after the provider confirms payment.`,
          'success',
          7000
        )
        void refreshBranchServerStatus()
        return
      }

      if (branchServerModeEnabled) {
        try {
          const localClaimPayload =
            paymentMethod === 'insurance'
              ? buildInsuranceClaimPayload({
                  saleNumber: null,
                  soldItems,
                  total,
                  coverage: insuranceCoveredAmount,
                  topUp: patientTopUpAmount,
                  topUpMethod: patientTopUpMethod,
                  branchId: activeShift.branch_id,
                  saleDate: saleTimestamp,
                })
              : null
          const saleResult = await createBranchSale({
            ...salePayload,
            claimPayload: localClaimPayload,
          })
          let nhisReviewClaim = null
          let nhisReviewClaimError = null
          if (paymentMethod === 'nhia') {
            const reviewClaim = buildNhiaReviewClaim({
              saleNumber: saleResult.saleNumber,
              soldItems,
              retailTotal: retailNetTotal,
              claimTotal: insuranceCoveredAmount,
              pricingAdjustment: nhiaPricingAdjustment,
              branchId: activeShift.branch_id,
              saleDate: saleTimestamp,
            })
            try {
              if (reviewClaim) {
                nhisReviewClaim = await createNhisClaim(
                  reviewClaim.claimData,
                  reviewClaim.medicines,
                  {
                    useBranchServer: true,
                    // ✅ NHIS PHARMACY LEVEL PATCH START
                    pharmacyLevel: getFacilityPharmacyLevel(),
                    drugCatalog: soldItems,
                    // ✅ NHIS PHARMACY LEVEL PATCH END
                  }
                )
              }
            } catch (claimError) {
              console.warn('Local branch NHIA sale saved but NHIS review claim was not created:', claimError)
              nhisReviewClaimError = claimError
            }
          }
          const receiptData = buildReceiptData(saleResult.saleNumber)
          const nhisReviewClaimNumber = nhisReviewClaim?.claim_number || nhisReviewClaim?.claimNumber
          const claimMessage = nhisReviewClaimNumber
            ? ` NHIS review claim ${nhisReviewClaimNumber} was created for claims officer review.`
            : nhisReviewClaimError
              ? ` NHIS review claim was not created: ${nhisReviewClaimError.message || 'review it from NHIS when ready.'}`
              : saleResult.claimNumber
              ? ` Claim ${saleResult.claimNumber} was saved locally.`
              : ''

          setLastSale({ ...receiptData, offline: true, branchServer: true })
          reduceSoldDrugQuantities(soldItems)
          setCart([])
          setSearchTerm('')
          syncSearchParam('')
          setReceived('')
          setDiscountType('amount')
          setDiscountValue('')
          setInsuranceCoverage('')
          setPatientTopUp('')
          setPatientTopUpMethod('cash')
          setNhiaDiagnosis('')
          setNhiaDiagnosisDetails([])
          selectPatientForSale(null)
          const syncMessage = isOnline
            ? ' Review records have been queued for sync.'
            : ' It will sync when internet returns.'
          notify(
            `Sale saved to the local branch server.${claimMessage}${syncMessage}`,
            'success'
          )
          setShowReceipt(true)
          return
        } catch (branchSaleError) {
          console.warn('Local branch sale failed:', branchSaleError)
          notify(
            branchSaleError.message || 'Local branch server is unavailable.',
            paymentMethod === 'nhia' || !isOnline ? 'error' : 'warning'
          )
          return
        }
      }

      if (!isOnline) {
        if (branchServerModeEnabled) {
          try {
            const localClaimPayload =
              paymentMethod === 'insurance'
                ? buildInsuranceClaimPayload({
                    saleNumber: null,
                    soldItems,
                    total,
                    coverage: insuranceCoveredAmount,
                    topUp: patientTopUpAmount,
                    topUpMethod: patientTopUpMethod,
                    branchId: activeShift.branch_id,
                    saleDate: saleTimestamp,
                  })
                : null
            const saleResult = await createBranchSale({
              ...salePayload,
              claimPayload: localClaimPayload,
            })
            const receiptData = buildReceiptData(saleResult.saleNumber)
            const claimMessage = saleResult.claimNumber
              ? ` Claim ${saleResult.claimNumber} was saved locally.`
              : ''

            setLastSale({ ...receiptData, offline: true, branchServer: true })
            reduceSoldDrugQuantities(soldItems)
            setCart([])
            setSearchTerm('')
            syncSearchParam('')
            setReceived('')
            setDiscountType('amount')
            setDiscountValue('')
            setInsuranceCoverage('')
            setPatientTopUp('')
            setPatientTopUpMethod('cash')
            setNhiaDiagnosis('')
            setNhiaDiagnosisDetails([])
            selectPatientForSale(null)
            notify(
              `Sale saved to the local branch server.${claimMessage} It will sync to Supabase when internet returns.`,
              'success'
            )
            setShowReceipt(true)
            return
          } catch (branchSaleError) {
            console.warn('Local branch sale failed; falling back to browser queue:', branchSaleError)
            notify(
              branchSaleError.message ||
                'Local branch server is unavailable. Saving in this browser instead.',
              'warning'
            )
          }
        }

        const offlineSaleNumber = createOfflineSaleNumber()
        const receiptData = buildReceiptData(offlineSaleNumber)
        const claimPayload =
          paymentMethod === 'insurance'
            ? buildInsuranceClaimPayload({
                saleNumber: offlineSaleNumber,
                soldItems,
                total,
                coverage: insuranceCoveredAmount,
                topUp: patientTopUpAmount,
                topUpMethod: patientTopUpMethod,
                branchId: activeShift.branch_id,
                saleDate: saleTimestamp,
              })
            : null

        await queueOfflineSale({
          salePayload,
          claimPayload,
          receiptData,
          organizationId: profile?.organization_id,
          branchId: activeShift.branch_id,
          createdBy: user?.id || null,
        })

        setLastSale({ ...receiptData, offline: true })
        reduceSoldDrugQuantities(soldItems)
        setCart([])
        setSearchTerm('')
        syncSearchParam('')
        setReceived('')
        setDiscountType('amount')
        setDiscountValue('')
        setInsuranceCoverage('')
        setPatientTopUp('')
        setPatientTopUpMethod('cash')
        setNhiaDiagnosis('')
        setNhiaDiagnosisDetails([])
        selectPatientForSale(null)
        await refreshOfflineSalesSummary()
        notify('Sale saved offline. Keep this shift open until it syncs when internet returns.', 'success')
        setShowReceipt(true)
        return
      }

      const saleResult = await createSale(salePayload)
      const receiptData = buildReceiptData(saleResult.saleNumber)
      setLastSale(receiptData)

      let claimMessage = ''
      if (paymentMethod === 'insurance') {
        try {
          const claimResult = await createInsuranceClaimForSale({
            saleNumber: saleResult.saleNumber,
            soldItems,
            total,
            coverage: insuranceCoveredAmount,
            topUp: patientTopUpAmount,
            topUpMethod: patientTopUpMethod,
            branchId: activeShift.branch_id,
            saleDate: saleTimestamp,
          })
          if (claimResult?.claimNumber) {
            claimMessage = ` Claim ${claimResult.claimNumber} was submitted.`
          }
        } catch (claimError) {
          console.warn('Sale completed but insurance claim was not created:', claimError)
          claimMessage = ` Claim was not auto-submitted: ${
            claimError.message || 'submit it from Claims when ready.'
          }`
        }
      }

      // Clear cart
      reduceSoldDrugQuantities(soldItems)
      setCart([])
      setSearchTerm('')
      syncSearchParam('')
      setReceived('')
      setDiscountType('amount')
      setDiscountValue('')
      setInsuranceCoverage('')
      setPatientTopUp('')
      setPatientTopUpMethod('cash')
      setNhiaDiagnosis('')
      setNhiaDiagnosisDetails([])
      selectPatientForSale(null)
      
      notify(`Sale completed successfully.${claimMessage}`, 'success')
      
      // Show receipt modal
      setShowReceipt(true)
      void Promise.all([
        refreshDrugs(),
        getOpenShiftForUser(user?.id)
          .then((refreshedShift) => setActiveShift(refreshedShift))
          .catch((shiftRefreshError) => {
            console.error('Failed to refresh active shift:', shiftRefreshError)
          }),
        refreshRecentSales(),
      ]).finally(() => {
        dispatchHealthflowDataChanged()
      })
    } catch (saleError) {
      console.error('Error completing sale:', saleError)
      setError(saleError.message || 'Unable to complete sale.')
    } finally {
      setProcessing(false)
    }
  }

  const handleRefundSale = async (sale) => {
    if (!canProcessRefund || !sale?.id) {
      return
    }

    if (!activeShift?.id) {
      notify('Open a shift before processing refunds.', 'warning')
      return
    }

    if (!window.confirm(`Refund sale ${sale.sale_number}?`)) {
      return
    }

    const reasonInput = window.prompt('Refund reason (optional):', '')
    if (reasonInput === null) {
      return
    }

    try {
      setRefundingSaleId(sale.id)
      setError('')
      await refundSale({
        saleId: sale.id,
        reason: reasonInput.trim() || null,
        role,
        canRefund: Boolean(profile?.can_refund),
      })
      notify(`Sale ${sale.sale_number} refunded successfully.`, 'success')
      const refreshedShift = await getOpenShiftForUser(user?.id)
      setActiveShift(refreshedShift)
      await Promise.all([refreshDrugs(), refreshRecentSales()])
      dispatchHealthflowDataChanged()
    } catch (refundError) {
      console.error('Error refunding sale:', refundError)
      setError(refundError.message || 'Unable to refund sale.')
    } finally {
      setRefundingSaleId(null)
    }
  }

  const handleOpenShift = async (event) => {
    event.preventDefault()

    try {
      setShiftBusy(true)
      setError('')
      if (!effectiveBranchId && !isAdmin) {
        throw new Error('Ask an admin to assign your branch before opening a shift.')
      }
      if (branchServerModeEnabled) {
        const branchId = effectiveBranchId || fallbackBranch?.id
        const branch =
          activeBranches.find((row) => row.id === branchId) ||
          fallbackBranch ||
          profile?.branches ||
          null
        const shift = createLocalPosShift({
          branchId,
          branch,
          openingCash: Number(openingCash || 0),
          userId: user?.id,
        })
        if (!shift) {
          throw new Error('Select a branch before starting the local POS session.')
        }

        setActiveShift(shift)
        setOpeningCash('')
        void saveOfflinePosSnapshot(user?.id, {
          activeShift: shift,
          shiftBranchId: branchId,
          branches: branches.length ? branches : branch ? [branch] : [],
        })
        notify('Local POS session started. Sales will save to SQLite first.', 'success')
        return
      }

      const shift = await openShift({
        organizationId: profile?.organization_id,
        branchId: effectiveBranchId,
        openingCash: Number(openingCash || 0),
        openedBy: user?.id,
      })
      setActiveShift(shift)
      setOpeningCash('')
      notify('Shift opened. Sales can now be processed.', 'success')
    } catch (shiftError) {
      setError(shiftError.message || 'Unable to open shift.')
    } finally {
      setShiftBusy(false)
    }
  }

  const handleCloseShift = async (event) => {
    event.preventDefault()
    if (!activeShift?.id) return

    if (unsyncedOfflineSales > 0) {
      notify('Sync pending offline sales before closing this shift.', 'warning')
      return
    }

    try {
      setShiftBusy(true)
      setError('')
      if (activeShift.isLocalPosShift) {
        setActiveShift(null)
        setCountedCash('')
        setShiftNotes('')
        void saveOfflinePosSnapshot(user?.id, { activeShift: null })
        notify('Local POS session closed on this device.', 'success')
        return
      }

      await closeShift({
        shiftId: activeShift.id,
        countedCash: Number(countedCash || 0),
        notes: shiftNotes,
        closedBy: user?.id,
      })
      setActiveShift(null)
      setCountedCash('')
      setShiftNotes('')
      notify('Shift closed successfully.', 'success')
    } catch (shiftError) {
      setError(shiftError.message || 'Unable to close shift.')
    } finally {
      setShiftBusy(false)
    }
  }

  const handleReprintSale = async (sale) => {
    if (!sale?.id) {
      return
    }

    try {
      setReprintingSaleId(sale.id)
      setError('')
      const fullSale = branchServerModeEnabled
        ? await getBranchSale(sale.id)
        : await getSaleById(sale.id)
      const normalizedSale = fullSale.sale_number
        ? fullSale
        : {
            ...fullSale,
            sale_number: fullSale.saleNumber,
            sale_date: fullSale.saleDate,
            total_amount: fullSale.totalAmount,
            net_amount: fullSale.netAmount,
            payment_method: fullSale.paymentMethod,
            amount_paid: fullSale.amountPaid,
            change_given: fullSale.changeGiven,
          }
      const normalizedItems = (fullSale.sale_items || fullSale.items || []).map((item) => ({
        ...item,
        drug_name: item.drug_name || item.drugName,
        unit_price: item.unit_price ?? item.unitPrice,
        total_price: item.total_price ?? item.totalPrice,
      }))
      const receiptData = formatSaleForReceipt(
        normalizedSale,
        normalizedItems,
        fullSale.patients || null,
        fullSale.users?.full_name || fullSale.sold_by || 'Staff User'
      )
      setLastSale(receiptData)
      setShowReceipt(true)
    } catch (reprintError) {
      console.error('Error loading receipt:', reprintError)
      setError(reprintError.message || 'Unable to load receipt for this sale.')
    } finally {
      setReprintingSaleId(null)
    }
  }

  const handlePrintReceipt = () => {
    printReceipt()
  }

  const handleDownloadPDF = () => {
    if (lastSale) {
      downloadReceiptPDF(lastSale, pharmacyInfo)
      notify('Receipt PDF downloaded successfully.', 'success')
    }
  }

  const closeReceiptModal = () => {
    setShowReceipt(false)
  }

  const subtotal = calculateSubtotal()
  const saleDiscount = calculateSaleDiscount()
  const total = calculateTotal()
  const change = calculateChange()
  const nhisCoveredTotal = calculateNhisCoveredTotal()
  const isNhiaClaimSale = paymentMethod === 'nhia'
  const checkoutTotal = isNhiaClaimSale ? Math.min(nhisCoveredTotal, total) : total
  const nhiaPricingAdjustment = isNhiaClaimSale ? Math.max(total - checkoutTotal, 0) : 0
  const isInsuranceSale = paymentMethod === 'insurance' || isNhiaClaimSale
  const onlinePaymentDisabled = !isOnline || !branchServerModeEnabled || !branchServerStatus.online
  const servingNhisPatient = isInsuranceSale && isNhisPatient(selectedPatientForSale)
  const insuranceSplitAllowed = !isNhiaClaimSale && (!servingNhisPatient || canUseNhisTopups)
  const insuranceHasPatientDetails =
    !isInsuranceSale ||
    Boolean(
      selectedPatientForSale?.insurance_provider &&
        (isNhiaClaimSale ? selectedNhiaMemberNumber : selectedPatientForSale?.insurance_id)
    )

  useEffect(() => {
    if (!isInsuranceSale) {
      return
    }

    if (!cart.length) {
      if (insuranceCoverage || patientTopUp) {
        setInsuranceCoverage('')
        setPatientTopUp('')
      }
      return
    }

    const defaultCoverage =
      isNhiaClaimSale || (servingNhisPatient && canUseNhisTopups)
        ? Math.min(nhisCoveredTotal, total)
        : total
    const coverageInput = Number.parseFloat(insuranceCoverage)
    const coverage =
      insuranceCoverage && insuranceSplitAllowed
        ? Math.min(Math.max(coverageInput || 0, 0), total)
        : defaultCoverage
    const nextCoverage =
      insuranceCoverage && insuranceSplitAllowed && !servingNhisPatient && coverage < total
        ? insuranceCoverage
        : formatAmountInput(coverage)
    const nextTopUp = insuranceSplitAllowed
      ? formatAmountInput(Math.max(total - coverage, 0))
      : '0.00'

    if (insuranceCoverage !== nextCoverage) {
      setInsuranceCoverage(nextCoverage)
    }

    if (patientTopUp !== nextTopUp) {
      setPatientTopUp(nextTopUp)
    }
  }, [
    canUseNhisTopups,
    cart,
    insuranceCoverage,
    insuranceSplitAllowed,
    isInsuranceSale,
    isNhiaClaimSale,
    nhisCoveredTotal,
    patientTopUp,
    paymentMethod,
    servingNhisPatient,
    total,
  ])

  if (loading) {
    return (
      <div className="sales-page">
        <div className="page-header">
          <h1>Loading POS...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="sales-page">
      {/* Hidden Receipt for Printing */}
      {lastSale && <Receipt mode="print" saleData={lastSale} pharmacyInfo={pharmacyInfo} />}

      {/* Receipt Modal */}
      {showReceipt && lastSale && (
        <div className="receipt-modal-overlay">
          <div className="receipt-modal">
            <div className="receipt-modal-header">
              <h3>Receipt - {lastSale.saleNumber}</h3>
              <button onClick={closeReceiptModal} className="close-btn" aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className="receipt-preview">
              <Receipt mode="preview" saleData={lastSale} pharmacyInfo={pharmacyInfo} />
            </div>
            <div className="receipt-modal-actions">
              <button onClick={handlePrintReceipt} className="btn-print">
                <Printer size={18} />
                Print Receipt
              </button>
              <button onClick={handleDownloadPDF} className="btn-pdf">
                <Download size={18} />
                Download PDF
              </button>
              <button onClick={closeReceiptModal} className="btn-close-modal">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="page-header">
        <div>
          <h1>Sales (POS)</h1>
          <p>Quick drug dispensing and checkout</p>
        </div>
        {isAdmin && (
          <div className="pos-mode-toggle" aria-label="Sales mode">
            <button
              type="button"
              className={!posAdminMode ? 'active' : ''}
              onClick={() => setSalesMode('pos')}
            >
              POS Mode
            </button>
            <button
              type="button"
              className={posAdminMode ? 'active' : ''}
              onClick={() => setSalesMode('admin')}
            >
              Admin Mode
            </button>
          </div>
        )}
      </div>

      {error && <div className="pos-alert">{error}</div>}

      {(!isOnline || unsyncedOfflineSales > 0) && (
        <div className={`offline-pos-banner ${isOnline ? 'sync-ready' : 'offline'}`}>
          <div>
            <strong>{isOnline ? 'Offline sales waiting to sync' : 'Offline sales mode'}</strong>
            <span>
              {isOnline
                ? `${unsyncedOfflineSales} sale${unsyncedOfflineSales === 1 ? '' : 's'} pending. Sync before closing the shift.`
                : 'Sales will be saved on this device and synced when the internet returns.'}
            </span>
            {offlineSalesSummary.failed > 0 && (
              <span className="offline-pos-warning">
                {offlineSalesSummary.failed} sale{offlineSalesSummary.failed === 1 ? '' : 's'} need retry.
              </span>
            )}
          </div>
          {isOnline && unsyncedOfflineSales > 0 && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => syncPendingOfflineSales()}
              disabled={syncingOfflineSales}
            >
              {syncingOfflineSales ? 'Syncing...' : 'Sync Now'}
            </button>
          )}
        </div>
      )}

      {branchServerModeEnabled && !posAdminMode && (
        <div className={`branch-server-panel ${branchServerStatus.online ? 'connected' : 'disconnected'}`}>
          <div>
            <strong>Local POS Mode</strong>
            <span>
              {branchServerStatus.online
                ? 'Dispensing from the local SQLite cache. Cloud sync runs in the background.'
                : 'Using the browser cache until the local branch server is reachable.'}
            </span>
          </div>
        </div>
      )}

      {posAdminMode && (
        <div className={`branch-server-panel ${branchServerStatus.online ? 'connected' : 'disconnected'}`}>
          <div>
            <strong>Local Branch Server</strong>
            <span>
              {branchServerStatus.online
                ? `Connected to ${branchServerConfig.url}`
                : branchServerConfig.enabled
                  ? `Unavailable: ${branchServerStatus.message}`
                  : 'Configure this browser to use the pharmacy local server.'}
            </span>
            {branchServerStatus.health?.sync?.inventory?.lastInventoryImportAt && (
              <span>
                Inventory: {branchServerStatus.health.sync.inventory.lastInventoryImportCount || 0} item
                {branchServerStatus.health.sync.inventory.lastInventoryImportCount === 1 ? '' : 's'} cached at{' '}
                {new Date(branchServerStatus.health.sync.inventory.lastInventoryImportAt).toLocaleString()}
              </span>
            )}
            {branchSyncStatus && (
              <div className="branch-sync-status">
                <div className="branch-sync-total">
                  <span>Outbox</span>
                  <strong>
                    {branchSyncStatus.pending || 0} pending / {branchSyncStatus.failed || 0} failed / {branchSyncStatus.synced || 0} synced
                  </strong>
                </div>
                {branchRecordSyncEntries.length > 0 && (
                  <div className="branch-sync-grid">
                    {branchRecordSyncEntries.map(([entityType, summary]) => (
                      <div className="branch-sync-chip" key={entityType}>
                        <span>{BRANCH_SYNC_LABELS[entityType] || entityType}</span>
                        <strong>
                          {summary.pending || 0}/{summary.failed || 0}/{summary.synced || 0}
                        </strong>
                      </div>
                    ))}
                  </div>
                )}
                {branchEventSyncEntries.length > 0 && (
                  <span className="branch-sync-help">Module chips show pending / failed / synced records.</span>
                )}
                {branchSyncStatus.recentFailures?.records?.length > 0 && (
                  <span className="branch-sync-error">
                    Latest failed record: {BRANCH_SYNC_LABELS[branchSyncStatus.recentFailures.records[0].entity_type] || branchSyncStatus.recentFailures.records[0].entity_type} - {branchSyncStatus.recentFailures.records[0].last_sync_error}
                  </span>
                )}
                {branchSyncStatus.recentFailures?.events?.length > 0 && (
                  <span className="branch-sync-error">
                    Latest failed event: {branchSyncStatus.recentFailures.events[0].event_type} - {branchSyncStatus.recentFailures.events[0].last_error}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="branch-server-actions">
            <button type="button" className="btn btn-outline" onClick={configureBranchServer}>
              Configure
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={refreshBranchServerStatus}
              disabled={branchServerBusy}
            >
              Check
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={pullInventoryToBranchServer}
              disabled={!branchServerStatus.online || branchServerBusy}
            >
              {branchServerBusy ? 'Importing...' : 'Pull Inventory'}
            </button>
          </div>
        </div>
      )}

      <div className="shift-panel">
        {activeShift ? (
          <>
            <div className="shift-summary">
              <div>
                <span>{activeShift.isLocalPosShift ? 'Local POS Session' : 'Open Shift'}</span>
                <strong>{activeShift.branches?.name || 'Assigned branch'}</strong>
              </div>
              <div>
                <span>Opening Cash</span>
                <strong>GHS {Number(activeShift.opening_cash || 0).toFixed(2)}</strong>
              </div>
              <div>
                <span>Expected Cash</span>
                <strong>GHS {Number(activeShift.expected_cash || 0).toFixed(2)}</strong>
              </div>
            </div>
            {activeShift.isLocalPosShift ? (
              <div className="local-shift-note">
                <span>Sales are written locally first; the background sync worker handles cloud updates.</span>
              </div>
            ) : (
              <form className="shift-close-form" onSubmit={handleCloseShift}>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Cash at hand / counted cash"
                  value={countedCash}
                  onChange={(event) => setCountedCash(event.target.value)}
                  required
                />
                <input
                  type="text"
                  placeholder="Closing note"
                  value={shiftNotes}
                  onChange={(event) => setShiftNotes(event.target.value)}
                />
                <button type="submit" className="btn btn-outline" disabled={shiftBusy}>
                  {shiftBusy ? 'Closing...' : 'Close Shift'}
                </button>
              </form>
            )}
          </>
        ) : (
          <form className="shift-open-form" onSubmit={handleOpenShift}>
            <strong>{branchServerModeEnabled ? 'Start local POS session' : 'Open a shift to begin sales'}</strong>
            {assignedBranch ? (
              <div className="assigned-branch-field">
                <span>Assigned branch</span>
                <strong>{assignedBranch?.name || 'Assigned branch'}</strong>
              </div>
            ) : canChooseShiftBranch ? (
              <select
                value={shiftBranchId}
                onChange={(event) => setShiftBranchId(event.target.value)}
                required
                disabled={shiftBusy}
              >
                <option value="">Select branch</option>
                {activeBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}{branch.code ? ` (${branch.code})` : ''}
                  </option>
                ))}
              </select>
            ) : isAdmin && fallbackBranch ? (
              <div className="assigned-branch-field">
                <span>Branch</span>
                <strong>{fallbackBranch.name || 'Main branch'}</strong>
              </div>
            ) : (
              <div className="assigned-branch-field warning">
                <span>Branch required</span>
                <strong>{isAdmin ? 'Create a branch in Settings' : 'Ask admin to assign your branch'}</strong>
              </div>
            )}
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Opening cash"
              value={openingCash}
              onChange={(event) => setOpeningCash(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={shiftBusy || !effectiveBranchId}
            >
              {shiftBusy ? 'Opening...' : branchServerModeEnabled ? 'Start POS' : 'Open Shift'}
            </button>
          </form>
        )}
      </div>

      <div className="pos-layout">
        <div className="product-section">
          <div className="search-drug">
            <Search size={20} />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search drug, batch number, or scan barcode..."
              />
          </div>

          <div className="patient-select-card">
            <label htmlFor="sale-patient">Linked Patient (optional)</label>
            <div
              className="patient-combobox"
              onBlur={() => {
                window.setTimeout(() => setIsPatientSearchOpen(false), 120)
              }}
            >
              <input
                id="sale-patient"
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isPatientSearchOpen}
                aria-controls="sale-patient-options"
                aria-activedescendant={
                  filteredPatients[highlightedPatientIndex]
                    ? `sale-patient-option-${filteredPatients[highlightedPatientIndex].id}`
                    : undefined
                }
                value={patientSearchTerm}
                placeholder="Walk-in customer"
                onFocus={() => setIsPatientSearchOpen(true)}
                onChange={(event) => handlePatientSearchChange(event.target.value)}
                onKeyDown={handlePatientSearchKeyDown}
              />
              {patientId && (
                <button
                  type="button"
                  className="patient-clear-btn"
                  onClick={() => selectPatientForSale(null)}
                  aria-label="Clear linked patient"
                  title="Clear linked patient"
                >
                  <X size={16} />
                </button>
              )}
              {isPatientSearchOpen && (
                <div id="sale-patient-options" className="patient-options" role="listbox">
                  <button
                    type="button"
                    className={`patient-option ${!patientId && !patientSearchTerm ? 'selected' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectPatientForSale(null)}
                    role="option"
                    aria-selected={!patientId}
                  >
                    <strong>Walk-in customer</strong>
                    <span>No patient record linked</span>
                  </button>
                  {filteredPatients.length ? (
                    filteredPatients.map((patient, index) => (
                      <button
                        key={patient.id}
                        id={`sale-patient-option-${patient.id}`}
                        type="button"
                        className={`patient-option ${
                          patient.id === patientId || index === highlightedPatientIndex
                            ? 'selected'
                            : ''
                        }`}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setHighlightedPatientIndex(index)}
                        onClick={() => selectPatientForSale(patient)}
                        role="option"
                        aria-selected={patient.id === patientId}
                      >
                        <strong>{patient.full_name}</strong>
                        <span>{[patient.phone, patient.email].filter(Boolean).join(' | ')}</span>
                        {(patient.insurance_provider || patient.insurance_id) && (
                          <span className="patient-option-insurance">
                            Insurance: {patient.insurance_provider || 'No provider'}
                            {patient.insurance_id ? ` (${patient.insurance_id})` : ''}
                          </span>
                        )}
                      </button>
                    ))
                  ) : patientSearchLoading ? (
                    <div className="patient-option-empty">Searching local patients...</div>
                  ) : (
                    <div className="patient-option-empty">No matching patients found.</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="quick-add">
            <div className="drug-results-header">
              <div>
                <h3>Drug Results</h3>
                <span>
                  {drugSearchLoading
                    ? 'Searching...'
                    : `${drugs.length} result${drugs.length === 1 ? '' : 's'}`}
                </span>
              </div>
              <span className="drug-results-limit">Top {POS_DRUG_SEARCH_LIMIT}</span>
            </div>
            {drugSearchMessage && !drugSearchLoading ? (
              <p className="drug-results-empty">{drugSearchMessage}</p>
            ) : null}
            <div className="drug-grid" aria-busy={drugSearchLoading}>
              {drugSearchLoading && drugs.length === 0 ? (
                <div className="drug-results-loading">Searching inventory...</div>
              ) : (
                drugs.map((drug) => {
                  const reserved = getReservedQty(drug.id)
                  const remaining = Math.max(0, Number.parseFloat(drug.quantity || 0) - reserved)
                  const soldOut = remaining <= 0
                  const retailPrice = getEffectiveSellingPrice(drug)
                  const nhisPrice = getNhisCatalogPrice(drug)

                  return (
                    <button
                      key={drug.id}
                      className="drug-card"
                      onClick={() => addToCart(drug)}
                      disabled={soldOut}
                    >
                      <span className="drug-name">{drug.name}</span>
                      <span className="drug-batch">{drug.batch_number || 'No batch'}</span>
                      <span className="drug-price">GHS {retailPrice.toFixed(2)}</span>
                      {hasNhisCatalogPrice(drug) && (
                        <span className="drug-nhis-price">NHIS GHS {nhisPrice.toFixed(2)}</span>
                      )}
                      {/* ✅ NHIS PHARMACY LEVEL PATCH START */}
                      <span className="drug-batch">
                        {drug.medicine_access_level || drug.required_pharmacy_level || 'Level not configured'}
                      </span>
                      {/* ✅ NHIS PHARMACY LEVEL PATCH END */}
                      <span className={`drug-stock ${soldOut ? 'sold-out' : ''}`}>
                        {soldOut ? 'Out of stock' : `${remaining} in stock`}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          {recentSales.length > 0 && (
            <div className="refund-panel">
              <div className="refund-panel-header">
                <h3>Recent Sales</h3>
                {loadingRecentSales && <span>Refreshing...</span>}
              </div>
              <div className="refund-sales-list">
                {recentSales.length === 0 ? (
                  <p className="refund-empty">No recent completed sales available.</p>
                ) : (
                  recentSales.map((sale) => (
                    <div key={sale.id} className="refund-sale-row">
                      <div className="refund-sale-main">
                        <strong>{sale.sale_number}</strong>
                        <span>{sale.patients?.full_name || 'Walk-in customer'}</span>
                      </div>
                      <div className="refund-sale-meta">
                        <span>GHS {Number.parseFloat(sale.net_amount || 0).toFixed(2)}</span>
                        <span>{new Date(sale.sale_date).toLocaleString()}</span>
                      </div>
                      <button
                        type="button"
                        className="receipt-reprint-btn"
                        disabled={processing || reprintingSaleId === sale.id}
                        onClick={() => handleReprintSale(sale)}
                      >
                        {reprintingSaleId === sale.id ? 'Loading...' : 'Reprint'}
                      </button>
                      {canProcessRefund && (
                        <button
                          type="button"
                          className="refund-btn"
                          disabled={processing || refundingSaleId === sale.id}
                          onClick={() => handleRefundSale(sale)}
                        >
                          {refundingSaleId === sale.id ? 'Refunding...' : 'Refund'}
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="checkout-section">
          <div className="cart-header">
            <h3>Selected Items</h3>
            <span className="item-count">{cartCount} items</span>
          </div>

          <div className="cart-items">
            {cart.length === 0 ? (
              <div className="empty-cart">
                <ShoppingCart size={48} />
                <p>No items in cart</p>
                <span>Search or select drugs to add</span>
              </div>
            ) : (
              cart.map((item) => (
                <div key={item.id} className="cart-item">
                  <div className="item-info">
                    <span className="item-name">{item.name}</span>
                    <span className="item-price">GHS {item.price.toFixed(2)}</span>
                    {(isNhiaClaimSale || servingNhisPatient) && Number.parseFloat(item.nhisPrice) > 0 && (
                      <span className="item-nhis-price">
                        NHIS GHS {Number.parseFloat(item.nhisPrice).toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="item-controls">
                    <div className="quantity-controls">
                      <button type="button" onClick={() => updateQuantity(item.id, -1)} aria-label="Decrease quantity">
                        <Minus size={18} />
                      </button>
                      <input
                        type="number"
                        className="quantity-input"
                        value={item.quantity}
                        min="1"
                        max={item.available}
                        onChange={(e) => setItemQuantity(item.id, e.target.value, item.available)}
                        aria-label={`Quantity for ${item.name}`}
                      />
                      <button type="button" onClick={() => updateQuantity(item.id, 1)} aria-label="Increase quantity">
                        <Plus size={18} />
                      </button>
                    </div>
                    <span className="item-total">GHS {(item.price * item.quantity).toFixed(2)}</span>
                    <button className="remove-btn" onClick={() => removeItem(item.id)}>
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="checkout-summary">
            <div className="summary-lines">
              <div className="summary-line">
                <span>Subtotal</span>
                <strong>GHS {subtotal.toFixed(2)}</strong>
              </div>
              <div className="discount-line">
                <label htmlFor="sale-discount">Discount</label>
                <div className="discount-controls">
                  <select
                    value={discountType}
                    onChange={(event) => setDiscountType(event.target.value)}
                    aria-label="Discount type"
                  >
                    <option value="amount">GHS</option>
                    <option value="percent">%</option>
                  </select>
                  <input
                    id="sale-discount"
                    type="number"
                    min="0"
                    max={discountType === 'percent' ? '100' : undefined}
                    step="0.01"
                    value={discountValue}
                    onChange={(event) => setDiscountValue(event.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>
              {saleDiscount > 0 && (
                <div className="summary-line summary-line-muted">
                  <span>Discount applied</span>
                  <strong>- GHS {saleDiscount.toFixed(2)}</strong>
                </div>
              )}
            </div>

            <div className="total-section">
              <span className="total-label">{isNhiaClaimSale ? 'NHIS Covered Total' : 'Net Total'}</span>
              <span className="total-amount">GHS {checkoutTotal.toFixed(2)}</span>
            </div>

            <div className="payment-methods">
              <button
                type="button"
                className={`payment-btn ${paymentMethod === 'cash' ? 'active' : ''}`}
                onClick={() => handlePaymentMethodChange('cash')}
              >
                Cash
              </button>
              <button
                type="button"
                className={`payment-btn ${paymentMethod === 'momo' ? 'active' : ''}`}
                disabled={onlinePaymentDisabled}
                title={onlinePaymentDisabled ? 'Mobile Money requires internet and the local branch server.' : ''}
                onClick={() => handlePaymentMethodChange('momo')}
              >
                Mobile Money
              </button>
              <button
                type="button"
                className={`payment-btn ${paymentMethod === 'insurance' ? 'active' : ''}`}
                onClick={() => handlePaymentMethodChange('insurance')}
              >
                Insurance
              </button>
              <button
                type="button"
                className={`payment-btn ${paymentMethod === 'nhia' ? 'active' : ''}`}
                onClick={() => handlePaymentMethodChange('nhia')}
              >
                NHIA Claim
              </button>
              <button
                type="button"
                className={`payment-btn ${paymentMethod === 'card' ? 'active' : ''}`}
                disabled={onlinePaymentDisabled}
                title={onlinePaymentDisabled ? 'Card payments require internet and the local branch server.' : ''}
                onClick={() => handlePaymentMethodChange('card')}
              >
                Card
              </button>
            </div>

            {(paymentMethod === 'momo' || paymentMethod === 'card') && (
              <div className="cash-panel">
                <div className="cash-field cash-field-input">
                  <label htmlFor="payment-provider">Provider</label>
                  <select
                    id="payment-provider"
                    value={paymentProvider}
                    onChange={(event) => setPaymentProvider(event.target.value)}
                  >
                    <option value="paystack">Paystack</option>
                    <option value="hubtel">Hubtel</option>
                  </select>
                </div>
                {(paymentMethod === 'momo' || paymentProvider === 'hubtel') && (
                  <div className="cash-field cash-field-input">
                    <label htmlFor="payment-phone">Mobile Number</label>
                    <input
                      id="payment-phone"
                      value={paymentPhone}
                      onChange={(event) => setPaymentPhone(event.target.value)}
                      placeholder="024XXXXXXX"
                    />
                  </div>
                )}
                <div className="cash-field cash-field-input">
                  <label htmlFor="payment-email">Customer Email</label>
                  <input
                    id="payment-email"
                    type="email"
                    value={paymentEmail}
                    onChange={(event) => setPaymentEmail(event.target.value)}
                    placeholder="Optional for Paystack receipt"
                  />
                </div>
              </div>
            )}

            {paymentMethod === 'cash' && (
              <div className="cash-panel">
                <div className="cash-field cash-field-input">
                  <label htmlFor="cash-received">Cash Received</label>
                  <div className="cash-input-shell">
                    <span className="cash-prefix">GHS</span>
                    <input
                      id="cash-received"
                      type="number"
                      value={received}
                      onChange={(e) => setReceived(e.target.value)}
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                    />
                  </div>
                </div>
                <div className="cash-field cash-field-change">
                  <span className="cash-field-label">Change Due</span>
                  <span className="change-amount">GHS {change.toFixed(2)}</span>
                </div>
              </div>
            )}

            {isInsuranceSale && (
              <div className="insurance-panel">
                {selectedPatientForSale ? (
                  <div
                    className={`insurance-card ${
                      insuranceHasPatientDetails ? '' : 'insurance-card-warning'
                    }`}
                  >
                    <span className="insurance-label">
                      {isNhiaClaimSale ? 'Patient NHIA' : 'Patient Insurance'}
                    </span>
                    <strong>
                      {selectedPatientForSale.insurance_provider || 'No insurance provider saved'}
                    </strong>
                    <span>
                      {(isNhiaClaimSale ? selectedNhiaMemberNumber : selectedPatientForSale.insurance_id)
                        ? `ID: ${isNhiaClaimSale ? selectedNhiaMemberNumber : selectedPatientForSale.insurance_id}`
                        : 'No insurance ID saved'}
                    </span>
                  </div>
                ) : (
                  <div className="insurance-card insurance-card-warning">
                    <span className="insurance-label">
                      {isNhiaClaimSale ? 'Patient NHIA' : 'Patient Insurance'}
                    </span>
                    <strong>Select a linked patient</strong>
                    <span>{isNhiaClaimSale ? 'NHIA claim sales' : 'Insurance sales'} need a patient with insurance details.</span>
                  </div>
                )}

                {isNhiaClaimSale && isHospital && (
                  <div className="cash-field cash-field-input nhia-diagnosis-field">
                    <label htmlFor="nhia-diagnosis">Diagnoses</label>
                    <DiagnosisSelector
                      id="nhia-diagnosis"
                      value={nhiaDiagnosis}
                      details={nhiaDiagnosisDetails}
                      onChange={(diagnosis, diagnosisDetails) => {
                        setNhiaDiagnosis(diagnosis)
                        setNhiaDiagnosisDetails(diagnosisDetails)
                      }}
                    />
                  </div>
                )}

                <div className="insurance-split-grid">
                  {isNhiaClaimSale && (
                    <div className="nhis-price-summary">
                      <span>Normal total: GHS {total.toFixed(2)}</span>
                      <strong>NHIS covered claim: GHS {checkoutTotal.toFixed(2)}</strong>
                      {nhiaPricingAdjustment > 0 && (
                        <span>Pricing adjustment: GHS {nhiaPricingAdjustment.toFixed(2)}</span>
                      )}
                    </div>
                  )}
                  {servingNhisPatient && !isNhiaClaimSale && (
                    <div className="nhis-price-summary">
                      <span>Normal total: GHS {total.toFixed(2)}</span>
                      {canUseNhisTopups ? (
                        <>
                          <span>NHIS total: GHS {Math.min(nhisCoveredTotal, total).toFixed(2)}</span>
                          <strong>Top-up: GHS {Math.max(total - nhisCoveredTotal, 0).toFixed(2)}</strong>
                        </>
                      ) : (
                        <strong>NHIS top-up disabled</strong>
                      )}
                    </div>
                  )}
                  <div className="cash-field cash-field-input">
                    <label htmlFor="insurance-covered">
                      {isNhiaClaimSale ? 'NHIS Covered Amount' : 'Insurance Cover'}
                    </label>
                    <div className="cash-input-shell">
                      <span className="cash-prefix">GHS</span>
                      <input
                        id="insurance-covered"
                        type="number"
                        value={insuranceCoverage}
                        onChange={(event) => handleInsuranceCoverageChange(event.target.value)}
                        disabled={isNhiaClaimSale || (servingNhisPatient && !canUseNhisTopups)}
                        step="0.01"
                        min="0"
                        max={total}
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                  {insuranceSplitAllowed && (
                    <div className="cash-field cash-field-input">
                      <label htmlFor="patient-top-up">Patient Top-Up</label>
                      <div className="cash-input-shell">
                        <span className="cash-prefix">GHS</span>
                        <input
                          id="patient-top-up"
                          type="number"
                          value={patientTopUp}
                          onChange={(event) => handlePatientTopUpChange(event.target.value)}
                          step="0.01"
                          min="0"
                          max={total}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  )}
                  {insuranceSplitAllowed && Number.parseFloat(patientTopUp) > 0 && (
                    <div className="cash-field cash-field-input insurance-top-up-method">
                      <label htmlFor="patient-top-up-method">Top-Up Paid By</label>
                      <select
                        id="patient-top-up-method"
                        value={patientTopUpMethod}
                        onChange={(event) => setPatientTopUpMethod(event.target.value)}
                      >
                        <option value="cash">Cash</option>
                        <option value="momo">Mobile Money</option>
                        <option value="card">Card</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}

            <button
              className="complete-sale-btn"
              disabled={
                cart.length === 0 ||
                processing ||
                !activeShift ||
                (isInsuranceSale && !insuranceHasPatientDetails)
              }
              onClick={handleCompleteSale}
            >
              {!activeShift
                ? 'Open Shift to Sell'
                : processing
                  ? isOnline
                    ? 'Completing Sale...'
                    : 'Saving Offline...'
                  : isOnline
                    ? 'Complete Sale'
                    : branchServerModeEnabled
                      ? 'Save to Branch Server'
                      : 'Save Offline Sale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Sales
