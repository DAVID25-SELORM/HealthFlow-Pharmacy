import { useEffect, useMemo, useState } from 'react'
import {
  Plus,
  Search,
  Filter,
  Edit2,
  Trash2,
  Upload,
  Download,
  RefreshCcw,
  Truck,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { dispatchHealthflowDataChanged } from '../lib/appEvents'
import {
  calculateDrugStatus,
  createInventoryDrug,
  deleteInventoryDrug,
  discardOfflineInventoryConflicts,
  getInventory,
  getOfflineInventorySummary,
  isDefaultCatalogDrug,
  isLocalInventoryEnabled,
  subscribeOfflineInventoryQueue,
  syncOfflineInventory,
  transferInventoryDrug,
  updateInventoryDrug,
} from '../services/inventoryApi'
import { parseExcelFile, validateImportData, importDrugs, generateTemplate } from '../services/drugImportService'
import { confirmAction } from '../utils/actionConfirmation'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { useTenant } from '../context/TenantContext'
import { formatAppDate } from '../utils/date'
import { getPharmacySettings } from '../services/settingsService'
import { getBranches } from '../services/branchService'
import { loadOfflinePosSnapshot, saveOfflinePosSnapshot } from '../services/offlinePosCache'
import { getEffectiveSellingPrice, getNhisCatalogPrice, hasNhisCatalogPrice } from '../utils/drugPricing'
// ✅ NHIS PHARMACY LEVEL PATCH START
import { MEDICINE_ACCESS_LEVELS, PHARMACY_LEVELS } from '../utils/nhisPharmacyLevel'
// ✅ NHIS PHARMACY LEVEL PATCH END
import './Inventory.css'

const emptyDrugForm = {
  name: '',
  batchNumber: '',
  expiryDate: '',
  quantity: '',
  unit: 'tablet',
  category: 'medicine',
  costPrice: '',
  price: '',
  nhisPrice: '',
  nhisCode: '',
  nhisUnit: '',
  isNhisListed: false,
  // ✅ NHIS PHARMACY LEVEL PATCH START
  medicineAccessLevel: '',
  requiredPharmacyLevel: '',
  // ✅ NHIS PHARMACY LEVEL PATCH END
  supplier: '',
  saleOnReturn: false,
}

const unitOptions = [
  { value: 'tablet', label: 'Tablet' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'vial', label: 'Vial' },
  { value: 'bottle', label: 'Bottle' },
  { value: 'sachet', label: 'Sachet' },
  { value: 'syrup', label: 'Syrup' },
  { value: 'cream', label: 'Cream' },
  { value: 'ointment', label: 'Ointment' },
  { value: 'drops', label: 'Drops' },
  { value: 'injection', label: 'Injection' },
  { value: 'pack', label: 'Pack' },
  { value: 'unit', label: 'Unit' },
]

const categoryOptions = [
  { value: 'medicine', label: 'Medicine' },
  { value: 'consumable', label: 'Consumable' },
  { value: 'medical_equipment', label: 'Medical Equipment' },
  { value: 'non_medical', label: 'Non-Medical' },
  { value: 'supplement', label: 'Supplement' },
  { value: 'cosmetic', label: 'Cosmetic' },
]

const filterOptions = [
  { value: 'all', label: 'All Medicines' },
  { value: 'good', label: 'Good Stock' },
  { value: 'low', label: 'Low Stock' },
  { value: 'expiring', label: 'Expiring Soon' },
  { value: 'expired', label: 'Expired' },
]

const mapDrugToForm = (drug) => {
  const nhisPrice = getNhisCatalogPrice(drug)
  const hasCatalogPrice = hasNhisCatalogPrice(drug)
  const isNhisListed = Boolean(drug.is_nhis_listed && (drug.nhis_code || hasCatalogPrice))

  return {
    name: drug.name || '',
    batchNumber: drug.batch_number || drug.batch || '',
    expiryDate: drug.expiry_date || drug.expiry || '',
    quantity: String(drug.quantity ?? ''),
    unit: drug.unit || 'tablet',
    category: drug.category || 'medicine',
    costPrice: String(drug.cost_price ?? ''),
    price: String(getEffectiveSellingPrice(drug) ?? ''),
    nhisPrice: hasCatalogPrice ? String(nhisPrice) : '',
    nhisCode: isNhisListed ? drug.nhis_code || '' : '',
    nhisUnit: isNhisListed ? drug.nhis_unit || '' : '',
    isNhisListed,
    // ✅ NHIS PHARMACY LEVEL PATCH START
    medicineAccessLevel: drug.medicine_access_level || '',
    requiredPharmacyLevel: drug.required_pharmacy_level || '',
    // ✅ NHIS PHARMACY LEVEL PATCH END
    supplier: drug.supplier || '',
    saleOnReturn: Boolean(drug.sale_on_return),
  }
}

const getMarkupPercent = (value) => {
  const number = Number.parseFloat(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

const calculateMarkedUpPrice = (costPrice, markupPercent) => {
  const cost = Number.parseFloat(costPrice)
  if (!Number.isFinite(cost) || cost <= 0) return ''

  return (cost * (1 + getMarkupPercent(markupPercent) / 100)).toFixed(2)
}

const Inventory = () => {
  const { role, profile, branch, user, canAdjustStock } = useAuth()
  const { notify } = useNotification()
  const { canUseNhis, canUseNhisTopups, organization, tierLimits } = useTenant()
  const organizationId =
    organization?.id || organization?.organization_id || profile?.organization_id || ''
  const showNhisPricing = Boolean(canUseNhis || canUseNhisTopups)
  const [searchParams, setSearchParams] = useSearchParams()
  const [showDrugModal, setShowDrugModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [editingDrugId, setEditingDrugId] = useState(null)
  const [drugs, setDrugs] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [highlightedDrugId, setHighlightedDrugId] = useState('')
  const [error, setError] = useState('')
  const [formData, setFormData] = useState(emptyDrugForm)
  const [defaultMarkupPercent, setDefaultMarkupPercent] = useState(0)
  const [priceEditedManually, setPriceEditedManually] = useState(false)
  const [importPreview, setImportPreview] = useState(null)
  const [branches, setBranches] = useState([])
  const [selectedBranchId, setSelectedBranchId] = useState('')
  const [transferDrug, setTransferDrug] = useState(null)
  const [transferForm, setTransferForm] = useState({ destinationBranchId: '', quantity: '', notes: '' })
  const [transferSubmitting, setTransferSubmitting] = useState(false)
  const [usingLocalInventory, setUsingLocalInventory] = useState(false)
  const [offlineSummary, setOfflineSummary] = useState({
    pending: 0,
    syncing: 0,
    failed: 0,
    conflicted: 0,
    synced: 0,
    unsynced: 0,
    total: 0,
  })
  const [syncingOfflineInventory, setSyncingOfflineInventory] = useState(false)

  useEffect(() => {
    void loadInitialInventory()
  }, [profile?.branch_id, branch?.id])

  useEffect(() => {
    const refreshSummary = async () => {
      setOfflineSummary(await getOfflineInventorySummary({ organizationId }))
    }
    const syncOnReconnect = async () => {
      if (!organizationId) return
      try {
        const summary = await getOfflineInventorySummary({ organizationId })
        if (summary.unsynced <= 0) return
        const result = await syncOfflineInventory({ organizationId })
        await refreshSummary()
        if (result.synced > 0) {
          notify(
            `${result.synced} inventory change${result.synced === 1 ? '' : 's'} synced.`,
            'success'
          )
          await loadDrugs(selectedBranchId, { manageLoading: false })
          dispatchHealthflowDataChanged()
        }
        if (result.conflicted > 0) {
          notify(
            `${result.conflicted} inventory change${result.conflicted === 1 ? '' : 's'} need manual review.`,
            'warning'
          )
        }
      } catch (syncError) {
        console.warn('Automatic offline inventory sync failed:', syncError)
        await refreshSummary()
      }
    }

    void refreshSummary()
    const unsubscribe = subscribeOfflineInventoryQueue(() => {
      void refreshSummary()
    })
    window.addEventListener('online', syncOnReconnect)
    if (navigator.onLine) {
      void syncOnReconnect()
    }

    return () => {
      unsubscribe()
      window.removeEventListener('online', syncOnReconnect)
    }
  }, [organizationId])

  useEffect(() => {
    const routeSearch = searchParams.get('search') || ''
    const routeFilter = searchParams.get('filter')
    const validRouteFilter = filterOptions.some((option) => option.value === routeFilter)
      ? routeFilter
      : 'all'

    setSearchTerm((current) => (current === routeSearch ? current : routeSearch))
    setActiveFilter((current) => (current === validRouteFilter ? current : validRouteFilter))
  }, [searchParams])

  const updateQueryParams = (nextSearch, nextFilter) => {
    const params = new URLSearchParams(searchParams)

    if (nextSearch) {
      params.set('search', nextSearch)
    } else {
      params.delete('search')
    }

    if (nextFilter && nextFilter !== 'all') {
      params.set('filter', nextFilter)
    } else {
      params.delete('filter')
    }

    setSearchParams(params, { replace: true })
  }

  const getDefaultBranchId = (branchRows = branches) =>
    profile?.branch_id ||
    branch?.id ||
    branchRows.find((row) => row.is_active !== false && row.is_main)?.id ||
    branchRows.find((row) => row.is_active !== false)?.id ||
    ''

  const loadBrowserInventorySnapshot = async (notifyOnSuccess = true) => {
    const snapshot = await loadOfflinePosSnapshot(user?.id)
    if (!snapshot?.drugs?.length) return false

    setDrugs(snapshot.drugs)
    setBranches(snapshot.branches || [])
    setSelectedBranchId(snapshot.shiftBranchId || '')
    setUsingLocalInventory(true)
    setError('')
    if (notifyOnSuccess) {
      notify('Loaded inventory from this browser offline cache.', 'success')
    }
    return true
  }

  const loadInitialInventory = async () => {
    try {
      setLoading(true)
      setError('')

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (isLocalInventoryEnabled()) {
          try {
            await loadLocalInventory('', { notifyOnSuccess: false })
            return
          } catch (localError) {
            console.error('Unable to load cached local inventory:', localError)
          }
        }
        if (await loadBrowserInventorySnapshot(false)) {
          return
        }
        setError('Inventory is not cached for offline use yet. Go online once and refresh Inventory, or pull inventory into the local branch server.')
        return
      }

      if (!isSupabaseConfigured()) {
        console.warn('Supabase not configured, using sample data')
        setSampleData()
        return
      }

      const branchRows = await getBranches().catch((branchError) => {
        console.warn('Unable to load branches for inventory:', branchError)
        return []
      })
      const defaultBranchId = getDefaultBranchId(branchRows)

      setBranches(branchRows)
      setSelectedBranchId(defaultBranchId)
      await loadDrugs(defaultBranchId, { manageLoading: false })
    } catch (error) {
      console.error('Error loading inventory:', error)
      if (isLocalInventoryEnabled()) {
        try {
          await loadLocalInventory('', { notifyOnSuccess: true })
          return
        } catch (localError) {
          console.error('Unable to load cached local inventory:', localError)
        }
      }

      if (await loadBrowserInventorySnapshot(true)) {
        return
      }

      setError(error.message || 'Unable to load inventory right now.')
      notify(error.message || 'Unable to load inventory right now.', 'error')
    } finally {
      setLoading(false)
    }
  }

  const loadLocalInventory = async (branchIdOverride = selectedBranchId, options = {}) => {
    const { notifyOnSuccess = true } = options
    const data = await getInventory({
      source: 'branch',
      limit: 20000,
    })
    setBranches([])
    setSelectedBranchId(branchIdOverride || '')
    setDrugs(data)
    setDefaultMarkupPercent(0)
    setUsingLocalInventory(true)
    setError('')
    void saveOfflinePosSnapshot(user?.id, {
      drugs: data,
      drugsCacheMode: 'replace',
      shiftBranchId: branchIdOverride || '',
    })
    if (notifyOnSuccess) {
      notify('Loaded cached inventory from the local branch server.', 'success')
    }
  }

  const loadDrugs = async (branchIdOverride = selectedBranchId, options = {}) => {
    const { manageLoading = true } = options
    try {
      if (manageLoading) setLoading(true)
      setError('')
      if (!isSupabaseConfigured()) {
        console.warn('Supabase not configured, using sample data')
        setSampleData()
        return
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (isLocalInventoryEnabled()) {
          try {
            await loadLocalInventory(branchIdOverride, { notifyOnSuccess: false })
            return
          } catch (localError) {
            console.error('Unable to load cached local inventory:', localError)
          }
        }
        if (await loadBrowserInventorySnapshot(false)) {
          return
        }
        setError('Inventory is not cached for offline use yet. Go online once and refresh Inventory, or pull inventory into the local branch server.')
        return
      }

      const data = await getInventory({
        includeCatalog: true,
        branchId: branchIdOverride || undefined,
      })
      setDrugs(data)
      setUsingLocalInventory(false)
      void saveOfflinePosSnapshot(user?.id, {
        drugs: data,
        drugsCacheMode: 'replace',
        shiftBranchId: branchIdOverride || '',
      })

      try {
        const settings = await getPharmacySettings()
        setDefaultMarkupPercent(getMarkupPercent(settings?.default_markup_percent))
      } catch (settingsError) {
        console.warn('Unable to load default markup setting:', settingsError)
        setDefaultMarkupPercent(0)
      }
    } catch (error) {
      console.error('Error loading drugs:', error)
      if (isLocalInventoryEnabled()) {
        try {
          await loadLocalInventory(branchIdOverride, { notifyOnSuccess: true })
          return
        } catch (localError) {
          console.error('Unable to load cached local inventory:', localError)
        }
      }

      if (await loadBrowserInventorySnapshot(true)) {
        return
      }

      setError(error.message || 'Unable to load inventory right now.')
      notify(error.message || 'Unable to load inventory right now.', 'error')
    } finally {
      if (manageLoading) setLoading(false)
    }
  }

  const setSampleData = () => {
    setDrugs([
      {
        id: '1',
        name: 'Amoxicillin 500mg',
        batch_number: 'BT001',
        expiry_date: '2026-08-15',
        quantity: 12,
        price: 37,
      },
      {
        id: '2',
        name: 'Paracetamol 500mg',
        batch_number: 'BT002',
        expiry_date: '2025-12-20',
        quantity: 4,
        price: 5,
      },
      {
        id: '3',
        name: 'Ibuprofen 200mg',
        batch_number: 'BT003',
        expiry_date: '2024-06-30',
        quantity: 15,
        price: 1,
      },
      {
        id: '4',
        name: 'Vitamin C 1000mg',
        batch_number: 'BT004',
        expiry_date: '2026-11-10',
        quantity: 1.8,
        price: 1,
      },
    ])
    setLoading(false)
  }

  const visibleDrugs = useMemo(() => {
    const normalizedTerm = searchTerm.trim().toLowerCase()

    const filtered = drugs.filter((drug) => {
      const searchableText = [
        drug.name,
        drug.batch_number || drug.batch,
        drug.supplier,
        drug.category,
        drug.unit,
        drug.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      const matchesSearch =
        !normalizedTerm || searchableText.includes(normalizedTerm)
      const matchesFilter =
        activeFilter === 'all' || calculateDrugStatus(drug) === activeFilter

      return matchesSearch && matchesFilter
    })

    if (!highlightedDrugId) {
      return filtered
    }

    return [...filtered].sort((left, right) => {
      if (left.id === highlightedDrugId) return -1
      if (right.id === highlightedDrugId) return 1
      return 0
    })
  }, [activeFilter, drugs, highlightedDrugId, searchTerm])

  const stockSummary = useMemo(() => {
    const activeStockRows = drugs.filter((drug) => {
      const quantity = Number.parseFloat(drug.quantity ?? 0) || 0
      return quantity > 0
    })

    return activeStockRows.reduce(
      (summary, drug) => {
        const quantity = Number.parseFloat(drug.quantity ?? 0) || 0
        const price = getEffectiveSellingPrice(drug)
        const rawCostPrice = Number.parseFloat(drug.cost_price ?? 0)
        const costPrice = Number.isFinite(rawCostPrice) && rawCostPrice > 0 ? rawCostPrice : 0

        return {
          itemCount: summary.itemCount + 1,
          unitCount: summary.unitCount + quantity,
          retailValue: summary.retailValue + quantity * price,
          costValue: summary.costValue + quantity * costPrice,
        }
      },
      {
        itemCount: 0,
        unitCount: 0,
        retailValue: 0,
        costValue: 0,
      }
    )
  }, [drugs])

  const editingCatalogItem =
    Boolean(editingDrugId) && isDefaultCatalogDrug({ batch_number: formData.batchNumber })

  const resetForm = () => {
    setEditingDrugId(null)
    setFormData(emptyDrugForm)
    setPriceEditedManually(false)
  }

  const closeDrugModal = () => {
    setShowDrugModal(false)
    resetForm()
  }

  const openAddModal = () => {
    if (!canAdjustStock) {
      notify('You do not have permission to adjust inventory stock.', 'warning')
      return
    }
    resetForm()
    setShowDrugModal(true)
  }

  const openEditModal = (drug) => {
    if (!canAdjustStock) {
      notify('You do not have permission to adjust inventory stock.', 'warning')
      return
    }
    setEditingDrugId(drug.id)
    setFormData(mapDrugToForm(drug))
    setPriceEditedManually(false)
    setShowDrugModal(true)
  }

  const openTransferModal = (drug) => {
    if (!canAdjustStock) {
      notify('You do not have permission to adjust inventory stock.', 'warning')
      return
    }
    setTransferDrug(drug)
    setTransferForm({ destinationBranchId: '', quantity: '', notes: '' })
  }

  const closeTransferModal = () => {
    setTransferDrug(null)
    setTransferForm({ destinationBranchId: '', quantity: '', notes: '' })
  }

  const availableDestinationBranches = branches.filter(
    (row) => row.is_active !== false && row.id !== selectedBranchId
  )

  const handleCostPriceChange = (value) => {
    setFormData((current) => ({
      ...current,
      costPrice: value,
      price: priceEditedManually
        ? current.price
        : calculateMarkedUpPrice(value, defaultMarkupPercent),
    }))
  }

  const handleSellingPriceChange = (value) => {
    setPriceEditedManually(true)
    setFormData((current) => ({ ...current, price: value }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!canAdjustStock) {
      notify('You do not have permission to adjust inventory stock.', 'warning')
      return
    }

    try {
      setSubmitting(true)

      if (!isSupabaseConfigured()) {
        notify('Supabase not configured. Please update your .env file.', 'warning')
        return
      }

      if (editingDrugId) {
        const editingDrug = drugs.find((drug) => drug.id === editingDrugId)
        const updatedDrug = await updateInventoryDrug(editingDrugId, formData, {
          organizationId,
          branchId: selectedBranchId || branch?.id || profile?.branch_id || null,
          createdBy: user?.id || null,
          expectedUpdatedAt: editingDrug?.updated_at || null,
        })
        if (!updatedDrug?.offlineQueued) {
          setDrugs((current) =>
            current.map((drug) => (drug.id === updatedDrug?.id ? updatedDrug : drug))
          )
        }
        notify(
          updatedDrug?.offlineQueued
            ? 'Inventory change saved offline and will sync when connection returns.'
            : 'Medicine updated successfully!',
          'success'
        )
      } else {
        const createdDrug = await createInventoryDrug({
          ...formData,
          branchId: selectedBranchId || undefined,
        }, {
          organizationId,
          branchId: selectedBranchId || branch?.id || profile?.branch_id || null,
          createdBy: user?.id || null,
        })
        if (createdDrug?.id && !createdDrug?.offlineQueued) {
          setDrugs((current) => [createdDrug, ...current.filter((drug) => drug.id !== createdDrug.id)])
        }
        if (createdDrug?.offlineQueued) {
          notify(
            'New medicine saved offline and will sync when connection returns.',
            'success'
          )
          closeDrugModal()
          return
        }
        const revealedExisting = createdDrug?._saveAction === 'update_existing'
        setHighlightedDrugId(createdDrug?.id || '')
        notify(
          revealedExisting
            ? 'This medicine already existed, so we updated it and moved it to the top of the list.'
            : 'Drug added successfully!',
          revealedExisting ? 'info' : 'success',
          revealedExisting ? 6000 : undefined
        )
        setActiveFilter('all')
        setSearchTerm(revealedExisting ? createdDrug.name || '' : '')
        updateQueryParams(revealedExisting ? createdDrug.name || '' : '', 'all')
      }

      closeDrugModal()
      await loadDrugs()
      dispatchHealthflowDataChanged()
    } catch (error) {
      console.error('Error saving drug:', error)
      notify(`Error saving drug: ${error.message}`, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id) => {
    const targetDrug = drugs.find((drug) => drug.id === id)
    if (targetDrug && isDefaultCatalogDrug(targetDrug)) {
      notify('Default catalog medicines stay available to all facilities and cannot be deleted.', 'info')
      return
    }

    if (!confirmAction({
      title: 'Move this inventory item to the Recycle Bin?',
      details: [
        { label: 'Medicine', value: targetDrug?.name },
        { label: 'Batch', value: targetDrug?.batch_number },
        { label: 'Quantity', value: targetDrug?.quantity },
      ],
      warning: 'The item will disappear from active inventory. An administrator can restore it.',
      confirmText: 'move this item to the Recycle Bin',
    })) return

    try {
      if (!isSupabaseConfigured() && !isLocalInventoryEnabled()) {
        notify('Supabase not configured.', 'warning')
        return
      }

      await deleteInventoryDrug(id)
      await loadDrugs()
      dispatchHealthflowDataChanged()
      notify('Inventory item moved to the Recycle Bin.', 'success')
    } catch (error) {
      console.error('Error deleting drug:', error)
      notify(`Error deleting drug: ${error.message}`, 'error')
    }
  }

  const handleBranchChange = async (branchId) => {
    setSelectedBranchId(branchId)
    await loadDrugs(branchId)
  }

  const handleTransferSubmit = async (event) => {
    event.preventDefault()

    if (!transferDrug) return

    try {
      setTransferSubmitting(true)
      await transferInventoryDrug({
        drugId: transferDrug.id,
        destinationBranchId: transferForm.destinationBranchId,
        quantity: transferForm.quantity,
        notes: transferForm.notes,
      })
      notify(`${transferDrug.name} transferred successfully.`, 'success')
      closeTransferModal()
      await loadDrugs(selectedBranchId)
      dispatchHealthflowDataChanged()
    } catch (error) {
      notify(error.message || 'Unable to transfer medicine.', 'error')
    } finally {
      setTransferSubmitting(false)
    }
  }

  const getStatusBadge = (drug) => {
    const status = calculateDrugStatus(drug)
    const statusConfig = {
      catalog: { label: 'Catalog Item', class: 'status-good' },
      good: { label: 'Good Stock', class: 'status-good' },
      low: { label: 'Low Stock', class: 'status-low' },
      expiring: { label: 'Expiring Soon', class: 'status-expiring' },
      expired: { label: 'Expired', class: 'status-expired' },
    }

    return statusConfig[status] || statusConfig.good
  }

  const handleDownloadTemplate = async () => {
    try {
      await generateTemplate()
      notify('Template downloaded successfully!', 'success')
    } catch (error) {
      notify(`Error downloading template: ${error.message}`, 'error')
    }
  }

  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!canAdjustStock) {
      notify('You do not have permission to adjust inventory stock.', 'warning')
      event.target.value = ''
      return
    }

    if (!tierLimits.hasAdvancedInventory) {
      notify('Bulk inventory import is available on Professional or Enterprise plans.', 'info')
      event.target.value = ''
      return
    }

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      notify('Please select an Excel file (.xlsx)', 'error')
      return
    }

    try {
      setImporting(true)
      const data = await parseExcelFile(file)
      const validation = validateImportData(data)

      setImportPreview(validation)
      setShowImportModal(true)
    } catch (error) {
      notify(`Error reading file: ${error.message}`, 'error')
    } finally {
      setImporting(false)
      // Reset file input
      event.target.value = ''
    }
  }

  const handleImport = async () => {
    if (!importPreview || importPreview.validCount === 0) {
      notify('No valid drugs to import', 'warning')
      return
    }

    if (!tierLimits.hasAdvancedInventory) {
      notify('Bulk inventory import is available on Professional or Enterprise plans.', 'info')
      return
    }

    if (!isSupabaseConfigured()) {
      notify('Supabase not configured. Please update your .env file.', 'warning')
      return
    }

    try {
      setImporting(true)
      const results = await importDrugs(importPreview.validRows)
      const createdCount = Array.isArray(results.created) ? results.created.length : results.successful.length
      const reactivatedCount = Array.isArray(results.reactivated) ? results.reactivated.length : 0
      const updatedCount = Array.isArray(results.updated) ? results.updated.length : 0

      if (results.successful.length > 0) {
        const parts = []
        if (createdCount > 0) parts.push(`${createdCount} new`)
        if (reactivatedCount > 0) parts.push(`${reactivatedCount} restored`)
        if (updatedCount > 0) parts.push(`${updatedCount} updated`)
        const successMessage = parts.length
          ? `Import complete: ${parts.join(', ')} drug(s).`
          : `Successfully imported ${results.successful.length} drug(s)!`

        notify(
          successMessage,
          'success'
        )
      }

      if (results.failed.length > 0) {
        const duplicateActiveCount = results.failed.filter((item) =>
          String(item?.error || '').toLowerCase().includes('already exists in inventory')
        ).length
        const warningMessage =
          duplicateActiveCount === results.failed.length
            ? `Skipped ${duplicateActiveCount} row(s) that already exist in active inventory.`
            : duplicateActiveCount > 0
              ? `Import completed with ${results.failed.length} issue(s). ${duplicateActiveCount} row(s) were skipped because they already exist in active inventory.`
              : `Failed to import ${results.failed.length} drug(s). Review the upload rows and try again.`

        notify(
          warningMessage,
          'warning',
          5000
        )
      }

      setShowImportModal(false)
      setImportPreview(null)
      await loadDrugs()
      dispatchHealthflowDataChanged()
    } catch (error) {
      notify(`Import error: ${error.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  const closeImportModal = () => {
    setShowImportModal(false)
    setImportPreview(null)
  }

  const handleOfflineInventorySync = async () => {
    try {
      setSyncingOfflineInventory(true)
      const result = await syncOfflineInventory({ organizationId })
      setOfflineSummary(await getOfflineInventorySummary({ organizationId }))
      if (result.skipped) {
        notify('Connect to the internet before syncing inventory changes.', 'warning')
      } else if (result.conflicted > 0) {
        notify(
          `${result.conflicted} inventory change${result.conflicted === 1 ? '' : 's'} conflict with newer cloud stock. Review before editing again.`,
          'warning'
        )
      } else if (result.failed > 0) {
        notify(
          `${result.failed} inventory change${result.failed === 1 ? '' : 's'} could not sync. Retry shortly.`,
          'error'
        )
      } else {
        notify(
          `${result.synced} inventory change${result.synced === 1 ? '' : 's'} synced successfully.`,
          'success'
        )
        await loadDrugs(selectedBranchId, { manageLoading: false })
        dispatchHealthflowDataChanged()
      }
    } catch (syncError) {
      console.error('Unable to sync offline inventory changes:', syncError)
      notify(syncError.message || 'Unable to sync offline inventory changes.', 'error')
    } finally {
      setSyncingOfflineInventory(false)
    }
  }

  const handleDiscardInventoryConflicts = async () => {
    if (
      !window.confirm(
        'Discard offline inventory conflicts and keep the latest cloud stock values?'
      )
    ) {
      return
    }

    try {
      const discarded = await discardOfflineInventoryConflicts({ organizationId })
      setOfflineSummary(await getOfflineInventorySummary({ organizationId }))
      await loadDrugs(selectedBranchId, { manageLoading: false })
      notify(
        `${discarded} conflicted change${discarded === 1 ? '' : 's'} discarded. Cloud stock reloaded.`,
        'info'
      )
    } catch (discardError) {
      notify(discardError.message || 'Unable to discard inventory conflicts.', 'error')
    }
  }

  const handleSearchChange = (value) => {
    setSearchTerm(value)
    updateQueryParams(value.trim(), activeFilter)
  }

  const handleFilterChange = (value) => {
    setActiveFilter(value)
    updateQueryParams(searchTerm.trim(), value)
  }

  if (loading) {
    return (
      <div className="inventory-page">
        <div className="page-header">
          <h1>Loading...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="inventory-page">
      <div className="page-header">
        <div>
          <h1>Inventory Management</h1>
          <p>Manage your drug stock, track expiry dates, and monitor low stock items</p>
        </div>
        <div className="header-actions">
          {branches.length > 0 && (
            <label className="branch-stock-select">
              <span>Branch stock</span>
              <select
                value={selectedBranchId}
                onChange={(event) => void handleBranchChange(event.target.value)}
                disabled={Boolean(profile?.branch_id)}
              >
                {branches.filter((row) => row.is_active !== false).map((row) => (
                  <option key={row.id} value={row.id}>{row.name}</option>
                ))}
              </select>
            </label>
          )}
          <button className="btn btn-secondary" type="button" onClick={handleDownloadTemplate}>
            <Download size={20} />
            Download Template
          </button>
          {canAdjustStock && (
            <>
              <label className="btn btn-secondary">
                <Upload size={20} />
                Import Excel
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                  disabled={importing || !tierLimits.hasAdvancedInventory}
                />
              </label>
              <button className="btn btn-primary" type="button" onClick={openAddModal}>
                <Plus size={20} />
                Add Drug
              </button>
            </>
          )}
        </div>
      </div>

      <div className="inventory-controls">
        <div className="search-box">
          <Search size={18} />
            <input
              type="text"
              placeholder="Search by name, batch number..."
              value={searchTerm}
              onChange={(event) => handleSearchChange(event.target.value)}
            />
        </div>
        <div className="filter-box">
          <Filter size={18} />
            <select
              value={activeFilter}
              onChange={(event) => handleFilterChange(event.target.value)}
              aria-label="Filter medicines"
            >
            {filterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="error-message" role="alert" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {usingLocalInventory && (
        <div className="inventory-local-banner" role="status">
          Showing cached inventory from the local branch server.
        </div>
      )}

      {offlineSummary.unsynced > 0 && (
        <div className="inventory-sync-banner" role="status">
          <div>
            <strong>Inventory changes waiting to sync</strong>
            <span>
              {offlineSummary.unsynced} change
              {offlineSummary.unsynced === 1 ? '' : 's'} stored securely on this device.
              {offlineSummary.conflicted > 0
                ? ` ${offlineSummary.conflicted} conflict with newer cloud stock and need review.`
                : offlineSummary.failed > 0
                  ? ` ${offlineSummary.failed} need retry.`
                  : ' They will sync automatically when internet returns.'}
            </span>
          </div>
          <div className="inventory-sync-actions">
            {offlineSummary.conflicted > 0 && (
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleDiscardInventoryConflicts}
                disabled={syncingOfflineInventory}
              >
                Discard conflicts
              </button>
            )}
            <button
              type="button"
              className="btn btn-outline"
              onClick={handleOfflineInventorySync}
              disabled={syncingOfflineInventory}
            >
              <RefreshCcw size={16} />
              {syncingOfflineInventory ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>
      )}

      <div className="inventory-summary-grid">
        <div className="inventory-summary-card">
          <span>Total Stock Value</span>
          <strong>GHS {stockSummary.retailValue.toFixed(2)}</strong>
          <small>Based on current selling prices</small>
        </div>
        <div className="inventory-summary-card">
          <span>Total Cost Value</span>
          <strong>GHS {stockSummary.costValue.toFixed(2)}</strong>
          <small>Based on recorded cost prices</small>
        </div>
        <div className="inventory-summary-card">
          <span>Stocked Medicines</span>
          <strong>{stockSummary.itemCount}</strong>
          <small>{stockSummary.unitCount.toLocaleString()} units available</small>
        </div>
      </div>

      <div className="table-container">
        <table className="inventory-table">
          <thead>
            <tr>
              <th>Drug Name</th>
              <th>Batch Number</th>
              <th>Supplier</th>
              <th>Expiry Date</th>
              <th>Quantity</th>
              <th>Price (GHS)</th>
              {showNhisPricing && <th>NHIS (GHS)</th>}
              <th>Total (GHS)</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleDrugs.length === 0 ? (
              <tr>
                <td colSpan={showNhisPricing ? 10 : 9} style={{ textAlign: 'center', padding: '2rem' }}>
                  {searchTerm || activeFilter !== 'all'
                    ? 'No medicines match the current search or filter.'
                    : 'No drugs in inventory. Click "Add Drug" to get started.'}
                </td>
              </tr>
            ) : (
              visibleDrugs.map((drug) => {
                const status = getStatusBadge(drug)
                const quantity = Number.parseFloat(drug.quantity ?? 0) || 0
                const price = getEffectiveSellingPrice(drug)
                const nhisPrice = getNhisCatalogPrice(drug)
                const total = (quantity * price).toFixed(2)
                const batchNumber = drug.batch_number || drug.batch || 'N/A'
                const expiryDate = drug.expiry_date || drug.expiry

                return (
                  <tr key={drug.id} className={drug.id === highlightedDrugId ? 'highlighted-drug-row' : ''}>
                    <td className="drug-name">
                      {drug.name}
                      {drug.sale_on_return && <div className="drug-subtext">Sale on return</div>}
                    </td>
                    <td>{batchNumber}</td>
                    <td>{drug.supplier || '-'}</td>
                    <td>{expiryDate ? formatAppDate(expiryDate) : 'N/A'}</td>
                    <td>{quantity}</td>
                    <td>GHS {price.toFixed(2)}</td>
                    {showNhisPricing && <td>{hasNhisCatalogPrice(drug) ? `GHS ${nhisPrice.toFixed(2)}` : '-'}</td>}
                    <td className="total-cell">GHS {total}</td>
                    <td>
                      <span className={`status-badge ${status.class}`}>{status.label}</span>
                    </td>
                    <td>
                      <div className="action-buttons">
                        {canAdjustStock && (
                          <button
                            className="icon-btn edit-btn"
                            title={`Edit ${drug.name}`}
                            type="button"
                            onClick={() => openEditModal(drug)}
                          >
                            <Edit2 size={16} />
                          </button>
                        )}
                        {canAdjustStock && availableDestinationBranches.length > 0 && Number.parseFloat(drug.quantity ?? 0) > 0 && (
                          <button
                            className="icon-btn transfer-btn"
                            title={`Transfer ${drug.name} to another branch`}
                            type="button"
                            onClick={() => openTransferModal(drug)}
                          >
                            <Truck size={16} />
                          </button>
                        )}
                        {role === 'admin' && canAdjustStock && (
                          <button
                            className="icon-btn delete-btn"
                            title={`Delete ${drug.name}`}
                            type="button"
                            onClick={() => handleDelete(drug.id)}
                            disabled={isDefaultCatalogDrug(drug)}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span className="page-info">
          Showing {visibleDrugs.length === 0 ? 0 : 1}-{visibleDrugs.length} of {drugs.length} items
        </span>
        <div className="page-buttons">
          <button className="page-btn" disabled>
            1
          </button>
        </div>
      </div>

      {showDrugModal && (
        <div className="modal-overlay" onClick={closeDrugModal}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingDrugId ? 'Edit Medicine' : 'Add New Drug'}</h2>
              <button className="close-btn" type="button" onClick={closeDrugModal}>
                x
              </button>
            </div>
            <form className="drug-form" onSubmit={handleSubmit}>
              {editingCatalogItem && (
                <p className="settings-note">
                  This is a shared catalog medicine. You can update stock values for this pharmacy,
                  but the medicine name and catalog code stay fixed.
                </p>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label>Drug Name *</label>
                  <input
                    type="text"
                    placeholder="e.g., Paracetamol 500mg"
                    required
                    value={formData.name}
                    onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                    disabled={editingCatalogItem}
                  />
                </div>
                <div className="form-group">
                  <label>Batch Number</label>
                  <input
                    type="text"
                    placeholder="e.g., BT001"
                    value={formData.batchNumber}
                    onChange={(event) => setFormData({ ...formData, batchNumber: event.target.value })}
                    disabled={editingCatalogItem}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Unit *</label>
                  <select
                    required
                    value={formData.unit}
                    onChange={(event) => setFormData({ ...formData, unit: event.target.value })}
                  >
                    {unitOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Category *</label>
                  <select
                    required
                    value={formData.category}
                    onChange={(event) => setFormData({ ...formData, category: event.target.value })}
                  >
                    {categoryOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Expiry Date *</label>
                  <input
                    type="date"
                    required
                    value={formData.expiryDate}
                    onChange={(event) => setFormData({ ...formData, expiryDate: event.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Quantity *</label>
                  <input
                    type="number"
                    placeholder="0"
                    required
                    min="0"
                    value={formData.quantity}
                    onChange={(event) => setFormData({ ...formData, quantity: event.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Cost Price (GHS)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    min="0"
                    value={formData.costPrice}
                    onChange={(event) => handleCostPriceChange(event.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Selling Price (GHS) *</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    required
                    min="0"
                    value={formData.price}
                    onChange={(event) => handleSellingPriceChange(event.target.value)}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Supplier</label>
                  <input
                    type="text"
                    placeholder="Supplier name"
                    value={formData.supplier}
                    onChange={(event) => setFormData({ ...formData, supplier: event.target.value })}
                  />
                </div>
              </div>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={formData.saleOnReturn}
                  onChange={(event) => setFormData({ ...formData, saleOnReturn: event.target.checked })}
                />
                <span>Sale on return</span>
              </label>

              {/* ✅ NHIS PHARMACY LEVEL PATCH START */}
              <div className="form-row">
                <div className="form-group">
                  <label>Medicine access level</label>
                  <select
                    value={formData.medicineAccessLevel}
                    onChange={(event) => setFormData({ ...formData, medicineAccessLevel: event.target.value })}
                  >
                    <option value="">Level not configured</option>
                    {MEDICINE_ACCESS_LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>{level.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Required pharmacy level</label>
                  <select
                    value={formData.requiredPharmacyLevel}
                    onChange={(event) => setFormData({ ...formData, requiredPharmacyLevel: event.target.value })}
                  >
                    <option value="">Any configured level</option>
                    {PHARMACY_LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>{level.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* ✅ NHIS PHARMACY LEVEL PATCH END */}

              {showNhisPricing && (
                <div className="form-row">
                  <div className="form-group">
                    <label>NHIS Code</label>
                    <input
                      type="text"
                      placeholder="e.g., ACETAZTA1"
                      value={formData.nhisCode}
                      onChange={(event) =>
                        setFormData({ ...formData, nhisCode: event.target.value, isNhisListed: true })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label>NHIS Price (GHS)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={formData.nhisPrice}
                      onChange={(event) =>
                        setFormData({ ...formData, nhisPrice: event.target.value, isNhisListed: true })
                      }
                    />
                  </div>
                </div>
              )}

              <div className="form-actions">
                <button type="button" className="btn btn-outline" onClick={closeDrugModal}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Saving...' : editingDrugId ? 'Update Medicine' : 'Save Drug'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {transferDrug && (
        <div className="modal-overlay" onClick={closeTransferModal}>
          <div className="modal-content transfer-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Transfer Medicine</h2>
              <button className="close-btn" type="button" onClick={closeTransferModal}>
                x
              </button>
            </div>
            <form className="drug-form" onSubmit={handleTransferSubmit}>
              <div className="transfer-summary">
                <strong>{transferDrug.name}</strong>
                <span>Available: {Number.parseFloat(transferDrug.quantity ?? 0)} {transferDrug.unit || 'unit'}</span>
              </div>

              <div className="form-group">
                <label>Destination Branch *</label>
                <select
                  required
                  value={transferForm.destinationBranchId}
                  onChange={(event) =>
                    setTransferForm((current) => ({
                      ...current,
                      destinationBranchId: event.target.value,
                    }))
                  }
                >
                  <option value="">Select branch</option>
                  {availableDestinationBranches.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Quantity to Transfer *</label>
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={Number.parseFloat(transferDrug.quantity ?? 0) || undefined}
                  value={transferForm.quantity}
                  onChange={(event) =>
                    setTransferForm((current) => ({ ...current, quantity: event.target.value }))
                  }
                />
              </div>

              <div className="form-group">
                <label>Notes</label>
                <textarea
                  rows="3"
                  value={transferForm.notes}
                  onChange={(event) =>
                    setTransferForm((current) => ({ ...current, notes: event.target.value }))
                  }
                />
              </div>

              <div className="form-actions">
                <button type="button" className="btn btn-outline" onClick={closeTransferModal}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={transferSubmitting || !transferForm.destinationBranchId}
                >
                  {transferSubmitting ? 'Transferring...' : 'Transfer Medicine'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImportModal && importPreview && (
        <div className="modal-overlay" onClick={closeImportModal}>
          <div className="modal-content import-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Import Drugs from Excel</h2>
              <button className="close-btn" type="button" onClick={closeImportModal}>
                x
              </button>
            </div>
            
            <div className="import-preview">
              <div className="import-stats">
                <div className="stat-card success">
                  <h3>{importPreview.validCount}</h3>
                  <p>Valid Rows</p>
                </div>
                <div className="stat-card danger">
                  <h3>{importPreview.invalidCount}</h3>
                  <p>Invalid Rows</p>
                </div>
                <div className="stat-card">
                  <h3>{importPreview.totalRows}</h3>
                  <p>Total Rows</p>
                </div>
              </div>

              {importPreview.invalidCount > 0 && (
                <div className="import-errors">
                  <h4>Import Errors</h4>
                  <div className="error-list">
                    {importPreview.invalidRows.slice(0, 5).map((invalid, idx) => (
                      <div key={idx} className="error-item">
                        <strong>Row {invalid.row}:</strong>
                        <ul>
                          {invalid.errors.map((err, errIdx) => (
                            <li key={errIdx}>{err}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {importPreview.invalidCount > 5 && (
                      <p className="more-errors">
                        ...and {importPreview.invalidCount - 5} more error(s). 
                        Invalid rows will be skipped.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {importPreview.validCount > 0 && (
                <div className="valid-preview">
                  <h4>Valid Drugs to Import</h4>
                  <div className="preview-table-wrapper">
                    <table className="preview-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Batch</th>
                          <th>Expiry</th>
                          <th>Qty</th>
                          <th>Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importPreview.validRows.slice(0, 5).map((drug, idx) => (
                          <tr key={idx}>
                            <td>{drug.name}</td>
                            <td>{drug.batch_number || '-'}</td>
                            <td>{drug.expiry_date}</td>
                            <td>{drug.quantity}</td>
                            <td>GHS {drug.price}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {importPreview.validCount > 5 && (
                      <p className="more-rows">
                        ...and {importPreview.validCount - 5} more drug(s)
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="form-actions">
              <button 
                type="button" 
                className="btn btn-outline" 
                onClick={closeImportModal}
                disabled={importing}
              >
                Cancel
              </button>
              <button 
                type="button" 
                className="btn btn-primary" 
                onClick={handleImport}
                disabled={importing || importPreview.validCount === 0}
              >
                {importing ? 'Importing...' : `Import ${importPreview.validCount} Drug(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Inventory
