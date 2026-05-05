import { useEffect, useMemo, useState } from 'react'
import { Search, Trash2, Plus, Minus, ShoppingCart, Printer, Download, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { dispatchHealthflowDataChanged } from '../lib/appEvents'
import { searchDrugs } from '../services/drugService'
import { createSale, getRecentSales, getSaleById, refundSale } from '../services/salesService'
import { createClaim } from '../services/claimsService'
import { getAllPatients } from '../services/patientService'
import { getPharmacySettings } from '../services/settingsService'
import { getBranches } from '../services/branchService'
import { closeShift, getOpenShiftForUser, openShift } from '../services/shiftService'
import { printReceipt, downloadReceiptPDF, formatSaleForReceipt } from '../services/receiptService'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { hasRole } from '../utils/roles'
import Receipt from '../components/Receipt/Receipt'
import './Sales.css'

const POS_DRUG_SEARCH_LIMIT = 30
const RECENT_SALES_LIMIT = 8
const POS_PATIENT_SEARCH_LIMIT = 8

const formatPatientOption = (patient) =>
  [patient?.full_name, patient?.phone ? `(${patient.phone})` : null].filter(Boolean).join(' ')

const formatAmountInput = (value) => Number(value || 0).toFixed(2)

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
})

const Sales = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { user, displayName, role, profile, organization } = useAuth()
  const { notify } = useNotification()
  const [drugs, setDrugs] = useState([])
  const [drugSearchLoading, setDrugSearchLoading] = useState(false)
  const [drugSearchMessage, setDrugSearchMessage] = useState('')
  const [patients, setPatients] = useState([])
  const [cart, setCart] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [patientId, setPatientId] = useState('')
  const [patientSearchTerm, setPatientSearchTerm] = useState('')
  const [isPatientSearchOpen, setIsPatientSearchOpen] = useState(false)
  const [highlightedPatientIndex, setHighlightedPatientIndex] = useState(0)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [received, setReceived] = useState('')
  const [insuranceCoverage, setInsuranceCoverage] = useState('')
  const [patientTopUp, setPatientTopUp] = useState('')
  const [patientTopUpMethod, setPatientTopUpMethod] = useState('cash')
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
  const canProcessRefund =
    hasRole(role, ['admin', 'pharmacist']) || Boolean(profile?.can_refund)
  const isAdmin = String(role || '').toLowerCase() === 'admin'
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
  const selectedPatientForSale = useMemo(
    () => patients.find((patient) => patient.id === patientId) || null,
    [patients, patientId]
  )
  const filteredPatients = useMemo(() => {
    const term = patientSearchTerm.trim().toLowerCase()
    const matches = term
      ? patients.filter((patient) =>
          [
            patient.full_name,
            patient.phone,
            patient.email,
            patient.insurance_provider,
            patient.insurance_id,
          ]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(term))
        )
      : patients

    return matches.slice(0, POS_PATIENT_SEARCH_LIMIT)
  }, [patientSearchTerm, patients])

  useEffect(() => {
    let cancelled = false

    const loadData = async () => {
      try {
        setLoading(true)
        setError('')

        if (!isSupabaseConfigured()) {
          setError('Supabase is not configured. Update .env to enable sales.')
          return
        }

        const [patientsData, pharmacySettings, branchesData, openShiftData] = await Promise.all([
          getAllPatients(),
          getPharmacySettings().catch(() => null),
          getBranches(),
          getOpenShiftForUser(user?.id),
        ])
        if (cancelled) {
          return
        }

        setPatients(patientsData)
        setPharmacyInfo(mergePharmacySettingsWithOrganization(pharmacySettings, organization))
        setBranches(branchesData)
        setActiveShift(openShiftData)
        setShiftBranchId(
          openShiftData?.branch_id ||
            profile?.branch_id ||
            branchesData.find((branch) => branch.is_active !== false && branch.is_main)?.id ||
            branchesData.find((branch) => branch.is_active !== false)?.id ||
            ''
        )
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
        setError(loadError.message || 'Unable to load POS data.')
        setLoading(false)
      }
    }

    loadData()

    return () => {
      cancelled = true
    }
  }, [canProcessRefund, organization, profile?.branch_id, role, user?.id])

  useEffect(() => {
    setHighlightedPatientIndex(0)
  }, [patientSearchTerm])

  useEffect(() => {
    if (loading || !isSupabaseConfigured()) {
      return undefined
    }

    let cancelled = false
    const term = searchTerm.trim()

    const searchInventory = async () => {
      try {
        setDrugSearchLoading(true)
        setDrugSearchMessage('')
        const results = await searchDrugs(term, {
          useTierAccess: true,
          inStockOnly: true,
          limit: POS_DRUG_SEARCH_LIMIT,
        })

        if (cancelled) {
          return
        }

        setDrugs(results)
        if (results.length === 0) {
          setDrugSearchMessage(term ? 'No matching in-stock drugs found.' : 'No in-stock drugs available.')
        }
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

    const timeout = window.setTimeout(searchInventory, term ? 250 : 0)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [loading, searchTerm])

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
      setIsPatientSearchOpen(false)
      return
    }

    setPatientId(patient.id)
    setPatientSearchTerm(formatPatientOption(patient))
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

  const calculateTotal = () => {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
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

  const addToCart = (drug) => {
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

      return [
        ...current,
        {
          id: drug.id,
          drugId: drug.id,
          name: drug.name,
          price: Number.parseFloat(drug.price),
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
      const latestDrugs = await searchDrugs(searchTerm, {
        useTierAccess: true,
        inStockOnly: true,
        limit: POS_DRUG_SEARCH_LIMIT,
      })
      setDrugs(latestDrugs)
    } catch (refreshError) {
      console.error('Failed to refresh inventory:', refreshError)
    }
  }

  const reduceSoldDrugQuantities = (soldItems) => {
    const soldQuantityByDrugId = new Map(
      soldItems.map((item) => [item.drugId, item.quantity])
    )

    setDrugs((currentDrugs) =>
      currentDrugs.map((drug) => {
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
    )
  }

  const refreshRecentSales = async () => {
    try {
      setLoadingRecentSales(true)
      const recent = await getRecentSales(RECENT_SALES_LIMIT)
      setRecentSales(recent || [])
    } catch (refreshError) {
      console.error('Failed to refresh recent sales:', refreshError)
    } finally {
      setLoadingRecentSales(false)
    }
  }

  const handlePaymentMethodChange = (method) => {
    setPaymentMethod(method)

    if (method !== 'cash') {
      setReceived('')
    }

    if (method !== 'insurance') {
      setInsuranceCoverage('')
      setPatientTopUp('')
      setPatientTopUpMethod('cash')
      return
    }

    const total = calculateTotal()
    setInsuranceCoverage(formatAmountInput(total))
    setPatientTopUp('0.00')
    setPatientTopUpMethod('cash')
  }

  const handleInsuranceCoverageChange = (value) => {
    const total = calculateTotal()
    const coverage = Math.min(Math.max(Number.parseFloat(value) || 0, 0), total)
    setInsuranceCoverage(value)
    setPatientTopUp(formatAmountInput(Math.max(total - coverage, 0)))
  }

  const handlePatientTopUpChange = (value) => {
    const total = calculateTotal()
    const topUp = Math.min(Math.max(Number.parseFloat(value) || 0, 0), total)
    setPatientTopUp(value)
    setInsuranceCoverage(formatAmountInput(Math.max(total - topUp, 0)))
  }

  const buildInsuranceSaleNotes = ({ saleNumber, total, coverage, topUp, topUpMethod }) =>
    [
      `Insurance sale ${saleNumber || ''}`.trim(),
      `Provider: ${selectedPatientForSale?.insurance_provider}`,
      `Insurance ID: ${selectedPatientForSale?.insurance_id}`,
      `Insurance covered: GHS ${coverage.toFixed(2)}`,
      `Patient top-up: GHS ${topUp.toFixed(2)}`,
      topUp > 0 ? `Top-up method: ${topUpMethod.toUpperCase()}` : null,
    ]
      .filter(Boolean)
      .join('\n')

  const buildInsuranceClaimItems = (soldItems, coverage, total) => {
    if (coverage >= total - 0.01) {
      return soldItems
    }

    const scale = total > 0 ? coverage / total : 0
    return soldItems.map((item) => ({
      ...item,
      price: item.price * scale,
    }))
  }

  const createInsuranceClaimForSale = async ({
    saleNumber,
    soldItems,
    total,
    coverage,
    topUp,
    topUpMethod,
  }) => {
    if (paymentMethod !== 'insurance' || coverage <= 0) {
      return null
    }

    const claimItems = buildInsuranceClaimItems(soldItems, coverage, total)
    return await createClaim({
      patientId: selectedPatientForSale.id,
      patientName: selectedPatientForSale.full_name,
      insuranceProvider: selectedPatientForSale.insurance_provider,
      insuranceId: selectedPatientForSale.insurance_id,
      serviceDate: new Date().toISOString().split('T')[0],
      notes: [
        `Auto-created from POS sale ${saleNumber}.`,
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
    })
  }

  const handleCompleteSale = async () => {
    if (!cart.length) {
      return
    }

    if (!activeShift?.id) {
      notify('Open a shift before completing sales.', 'warning')
      return
    }

    const total = calculateTotal()
    const amountPaid = Number.parseFloat(received) || 0
    const insuranceCoveredAmount = Number.parseFloat(insuranceCoverage) || 0
    const patientTopUpAmount = Number.parseFloat(patientTopUp) || 0

    if (paymentMethod === 'cash' && amountPaid < total) {
      notify('Received amount must be at least the total for cash payments.', 'warning')
      return
    }

    if (paymentMethod === 'insurance') {
      if (!selectedPatientForSale) {
        notify('Select a patient before completing an insurance sale.', 'warning')
        return
      }

      if (!selectedPatientForSale.insurance_provider || !selectedPatientForSale.insurance_id) {
        notify('The selected patient does not have insurance details on file.', 'warning')
        return
      }

      if (insuranceCoveredAmount <= 0) {
        notify('Enter how much the insurance is covering.', 'warning')
        return
      }

      if (Math.abs(insuranceCoveredAmount + patientTopUpAmount - total) > 0.01) {
        notify('Insurance cover and patient top-up must add up to the sale total.', 'warning')
        return
      }
    }

    try {
      setProcessing(true)
      setError('')
      const soldItems = cart.map((item) => ({
        drugId: item.drugId,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
      }))

      const saleResult = await createSale({
        items: soldItems,
        patientId: patientId || null,
        paymentMethod,
        amountPaid: paymentMethod === 'cash' ? amountPaid : total,
        change: paymentMethod === 'cash' ? calculateChange() : 0,
        notes:
          paymentMethod === 'insurance'
            ? buildInsuranceSaleNotes({
                total,
                coverage: insuranceCoveredAmount,
                topUp: patientTopUpAmount,
                topUpMethod: patientTopUpMethod,
              })
            : null,
        insuranceCoveredAmount:
          paymentMethod === 'insurance' ? insuranceCoveredAmount : null,
        insuranceTopUpAmount:
          paymentMethod === 'insurance' ? patientTopUpAmount : null,
        insuranceTopUpPaymentMethod:
          paymentMethod === 'insurance' && patientTopUpAmount > 0 ? patientTopUpMethod : null,
        soldBy: user?.id || null,
        shiftId: activeShift.id,
        organizationId: profile?.organization_id,
        branchId: activeShift.branch_id,
      })

      // Prepare receipt data with full sale details
      const receiptData = {
        saleNumber: saleResult.saleNumber,
        saleDate: new Date().toISOString(),
        items: cart.map((item) => ({
          drug_name: item.name,
          quantity: item.quantity,
          unit_price: item.price,
          total_price: item.quantity * item.price,
        })),
        totalAmount: total,
        discount: 0,
        netAmount: total,
        paymentMethod: paymentMethod,
        amountPaid: paymentMethod === 'cash' ? amountPaid : total,
        change: paymentMethod === 'cash' ? calculateChange() : 0,
        patient: selectedPatientForSale,
        insuranceDetails:
          paymentMethod === 'insurance'
            ? {
                provider: selectedPatientForSale.insurance_provider,
                insuranceId: selectedPatientForSale.insurance_id,
                coveredAmount: insuranceCoveredAmount,
                patientTopUp: patientTopUpAmount,
                patientTopUpMethod: patientTopUpAmount > 0 ? patientTopUpMethod : null,
              }
            : null,
        soldBy: displayName || user?.email,
      }
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
      setInsuranceCoverage('')
      setPatientTopUp('')
      setPatientTopUpMethod('cash')
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

    try {
      setShiftBusy(true)
      setError('')
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
      const fullSale = await getSaleById(sale.id)
      const receiptData = formatSaleForReceipt(
        fullSale,
        fullSale.sale_items || [],
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

  const total = calculateTotal()
  const change = calculateChange()
  const insuranceHasPatientDetails =
    paymentMethod !== 'insurance' ||
    Boolean(
      selectedPatientForSale?.insurance_provider &&
        selectedPatientForSale?.insurance_id
    )

  useEffect(() => {
    if (paymentMethod !== 'insurance') {
      return
    }

    if (!cart.length) {
      if (insuranceCoverage || patientTopUp) {
        setInsuranceCoverage('')
        setPatientTopUp('')
      }
      return
    }

    const coverageInput = Number.parseFloat(insuranceCoverage)
    const coverage = insuranceCoverage ? Math.min(Math.max(coverageInput || 0, 0), total) : total
    const nextCoverage =
      insuranceCoverage && coverage < total ? insuranceCoverage : formatAmountInput(coverage)
    const nextTopUp = formatAmountInput(Math.max(total - coverage, 0))

    if (insuranceCoverage !== nextCoverage) {
      setInsuranceCoverage(nextCoverage)
    }

    if (patientTopUp !== nextTopUp) {
      setPatientTopUp(nextTopUp)
    }
  }, [cart.length, paymentMethod, total])

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
        <h1>Sales (POS)</h1>
        <p>Quick drug dispensing and checkout</p>
      </div>

      {error && <div className="pos-alert">{error}</div>}

      <div className="shift-panel">
        {activeShift ? (
          <>
            <div className="shift-summary">
              <div>
                <span>Open Shift</span>
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
          </>
        ) : (
          <form className="shift-open-form" onSubmit={handleOpenShift}>
            <strong>Open a shift to begin sales</strong>
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
              {shiftBusy ? 'Opening...' : 'Open Shift'}
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

                  return (
                    <button
                      key={drug.id}
                      className="drug-card"
                      onClick={() => addToCart(drug)}
                      disabled={soldOut}
                    >
                      <span className="drug-name">{drug.name}</span>
                      <span className="drug-batch">{drug.batch_number || 'No batch'}</span>
                      <span className="drug-price">GHS {Number.parseFloat(drug.price).toFixed(2)}</span>
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
            <div className="total-section">
              <span className="total-label">Total</span>
              <span className="total-amount">GHS {total.toFixed(2)}</span>
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
                className={`payment-btn ${paymentMethod === 'card' ? 'active' : ''}`}
                onClick={() => handlePaymentMethodChange('card')}
              >
                Card
              </button>
            </div>

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

            {paymentMethod === 'insurance' && (
              <div className="insurance-panel">
                {selectedPatientForSale ? (
                  <div
                    className={`insurance-card ${
                      insuranceHasPatientDetails ? '' : 'insurance-card-warning'
                    }`}
                  >
                    <span className="insurance-label">Patient Insurance</span>
                    <strong>
                      {selectedPatientForSale.insurance_provider || 'No insurance provider saved'}
                    </strong>
                    <span>
                      {selectedPatientForSale.insurance_id
                        ? `ID: ${selectedPatientForSale.insurance_id}`
                        : 'No insurance ID saved'}
                    </span>
                  </div>
                ) : (
                  <div className="insurance-card insurance-card-warning">
                    <span className="insurance-label">Patient Insurance</span>
                    <strong>Select a linked patient</strong>
                    <span>Insurance sales need a patient with insurance details.</span>
                  </div>
                )}

                <div className="insurance-split-grid">
                  <div className="cash-field cash-field-input">
                    <label htmlFor="insurance-covered">Insurance Cover</label>
                    <div className="cash-input-shell">
                      <span className="cash-prefix">GHS</span>
                      <input
                        id="insurance-covered"
                        type="number"
                        value={insuranceCoverage}
                        onChange={(event) => handleInsuranceCoverageChange(event.target.value)}
                        step="0.01"
                        min="0"
                        max={total}
                        placeholder="0.00"
                      />
                    </div>
                  </div>
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
                  {Number.parseFloat(patientTopUp) > 0 && (
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
                (paymentMethod === 'insurance' && !insuranceHasPatientDetails)
              }
              onClick={handleCompleteSale}
            >
              {!activeShift ? 'Open Shift to Sell' : processing ? 'Completing Sale...' : 'Complete Sale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Sales
