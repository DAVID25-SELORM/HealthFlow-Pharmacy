import { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useNotification } from '../context/NotificationContext'
import { formatAppDateTime } from '../utils/date'
import { requestAppConfirmation } from '../utils/appDialog'
import {
  getDeletedRecords,
  permanentlyDeleteRecord,
  restoreDeletedRecord,
} from '../services/recycleBinService'
import { DataTable, EmptyState, LoadingState, PageHeader, StatusBadge } from '../components/ui'
import './RecycleBin.css'

const TYPE_LABELS = {
  inventory_drug: 'Inventory item',
  nhis_claim: 'NHIS claim',
}

const getRecordSnapshot = (record = {}) => record.snapshot?.record || record.snapshot || {}

export const filterRecycleBinRecords = (records = [], filters = {}, now = new Date()) => {
  const searchTerm = String(filters.searchTerm || '').trim().toLocaleLowerCase()
  const entityType = filters.entityType || 'all'
  const deletedWithin = filters.deletedWithin || 'all'
  const nowTime = now.getTime()
  const ageLimits = {
    today: 24 * 60 * 60 * 1000,
    '7_days': 7 * 24 * 60 * 60 * 1000,
    '30_days': 30 * 24 * 60 * 60 * 1000,
  }

  return records.filter((record) => {
    if (entityType !== 'all' && record.entity_type !== entityType) return false

    if (deletedWithin !== 'all') {
      const deletedAt = new Date(record.deleted_at).getTime()
      const ageLimit = ageLimits[deletedWithin]
      if (!Number.isFinite(deletedAt) || !ageLimit || deletedAt > nowTime || nowTime - deletedAt > ageLimit) {
        return false
      }
    }

    if (!searchTerm) return true

    const snapshot = getRecordSnapshot(record)
    const patientFullName = [snapshot.surname, snapshot.other_names].filter(Boolean).join(' ')
    const searchableValues = [
      record.display_name,
      record.entity_type,
      TYPE_LABELS[record.entity_type],
      snapshot.claim_number,
      snapshot.surname,
      snapshot.other_names,
      patientFullName,
      snapshot.patient_name,
      snapshot.patientName,
      snapshot.member_no,
      snapshot.memberNo,
      snapshot.hin,
      snapshot.folder_no,
      snapshot.folderNo,
      snapshot.name,
      snapshot.generic_name,
      snapshot.brand_name,
      snapshot.code,
    ]

    return searchableValues.some((value) => String(value || '').toLocaleLowerCase().includes(searchTerm))
  })
}

const getRecycleRecordIdentity = (record = {}) => {
  const snapshot = getRecordSnapshot(record)
  const claimNumber = snapshot.claim_number || record.display_name || ''
  const patientName = [snapshot.surname, snapshot.other_names].filter(Boolean).join(' ').trim()
    || snapshot.patient_name
    || snapshot.patientName
    || ''
  const memberNumber = snapshot.member_no || snapshot.memberNo || snapshot.hin || ''
  const folderNumber = snapshot.folder_no || snapshot.folderNo || ''

  if (record.entity_type !== 'nhis_claim') {
    return {
      primary: record.display_name,
      secondary: '',
      meta: '',
      confirmLabel: record.display_name,
    }
  }

  return {
    primary: claimNumber || 'NHIS claim',
    secondary: patientName,
    meta: [
      folderNumber ? `Folder: ${folderNumber}` : '',
      memberNumber ? `Member/HIN: ${memberNumber}` : '',
    ].filter(Boolean).join(' | '),
    confirmLabel: [claimNumber, patientName].filter(Boolean).join(' - ') || record.display_name,
  }
}

const RecycleBin = () => {
  const { notify } = useNotification()
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [entityType, setEntityType] = useState('all')
  const [deletedWithin, setDeletedWithin] = useState('all')

  const filteredRecords = useMemo(() => filterRecycleBinRecords(records, {
    searchTerm,
    entityType,
    deletedWithin,
  }), [deletedWithin, entityType, records, searchTerm])

  const hasActiveFilters = Boolean(searchTerm.trim()) || entityType !== 'all' || deletedWithin !== 'all'

  const clearFilters = () => {
    setSearchTerm('')
    setEntityType('all')
    setDeletedWithin('all')
  }

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError('')
      setRecords(await getDeletedRecords())
    } catch (loadError) {
      setError(loadError.message || 'Unable to load the Recycle Bin.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const restore = async (record) => {
    const identity = getRecycleRecordIdentity(record)
    if (!(await requestAppConfirmation({
      title: `Restore ${identity.confirmLabel}?`,
      confirmText: 'restore this record',
    }))) return
    try {
      setBusyId(record.id)
      await restoreDeletedRecord(record.id)
      await load()
      notify(`${identity.confirmLabel} restored.`, 'success')
    } catch (restoreError) {
      notify(restoreError.message || 'Unable to restore this record.', 'error')
    } finally {
      setBusyId('')
    }
  }

  const removePermanently = async (record) => {
    const identity = getRecycleRecordIdentity(record)
    if (!(await requestAppConfirmation({
      title: `Permanently delete ${identity.confirmLabel}?`,
      warning: 'This cannot be undone.',
      confirmText: 'delete permanently',
    }))) return
    try {
      setBusyId(record.id)
      await permanentlyDeleteRecord(record.id)
      await load()
      notify(`${identity.confirmLabel} permanently deleted.`, 'success')
    } catch (deleteError) {
      notify(deleteError.message || 'Unable to permanently delete this record.', 'error')
    } finally {
      setBusyId('')
    }
  }

  const columns = [
    {
      key: 'type',
      header: 'Type',
      render: (record) => (
        <StatusBadge tone={record.entity_type === 'nhis_claim' ? 'info' : 'neutral'}>
          {TYPE_LABELS[record.entity_type] || record.entity_type}
        </StatusBadge>
      ),
    },
    {
      key: 'identity',
      header: 'Name / Number',
      render: (record) => {
        const identity = getRecycleRecordIdentity(record)
        return (
          <div className="recycle-record-identity">
            <strong>{identity.primary}</strong>
            {identity.secondary && <span>{identity.secondary}</span>}
            {identity.meta && <small>{identity.meta}</small>}
          </div>
        )
      },
    },
    {
      key: 'deleted_at',
      header: 'Deleted',
      render: (record) => formatAppDateTime(record.deleted_at),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (record) => (
        <div className="recycle-bin-actions">
          <button className="btn btn-secondary btn-sm" disabled={busyId === record.id} onClick={() => restore(record)}>
            <RotateCcw size={14} /> Restore
          </button>
          <button className="btn btn-danger btn-sm" disabled={busyId === record.id} onClick={() => removePermanently(record)}>
            <Trash2 size={14} /> Delete Permanently
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="recycle-bin">
      <PageHeader
        eyebrow="Administration"
        title="Recycle Bin"
        description="Restore deleted inventory items and NHIS claims, or remove them permanently."
      />
      {error && (
        <div className="nhis-alert recycle-bin-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      <div className="recycle-bin-toolbar" aria-label="Recycle Bin filters">
        <label className="recycle-bin-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search deleted records</span>
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search claim, patient, member/HIN, folder, or item..."
          />
        </label>
        <label className="recycle-bin-filter">
          <span>Type</span>
          <select value={entityType} onChange={(event) => setEntityType(event.target.value)}>
            <option value="all">All records</option>
            <option value="nhis_claim">NHIS claims</option>
            <option value="inventory_drug">Inventory items</option>
          </select>
        </label>
        <label className="recycle-bin-filter">
          <span>Deleted</span>
          <select value={deletedWithin} onChange={(event) => setDeletedWithin(event.target.value)}>
            <option value="all">Any time</option>
            <option value="today">Past 24 hours</option>
            <option value="7_days">Past 7 days</option>
            <option value="30_days">Past 30 days</option>
          </select>
        </label>
        {hasActiveFilters && (
          <button type="button" className="btn btn-secondary btn-sm recycle-bin-clear" onClick={clearFilters}>
            <X size={14} /> Clear
          </button>
        )}
      </div>
      {!loading && !error && (
        <div className="recycle-bin-result-count" role="status">
          Showing {filteredRecords.length} of {records.length} deleted records
        </div>
      )}
      <DataTable
        columns={columns}
        rows={filteredRecords}
        getRowKey={(record) => record.id}
        loading={loading}
        loadingState={<LoadingState title="Loading deleted records" description="Checking recoverable records..." />}
        emptyState={hasActiveFilters
          ? <EmptyState title="No deleted records match" description="Change or clear the search filters to see other records." />
          : <EmptyState title="The Recycle Bin is empty" description="Deleted inventory items and NHIS claims will appear here." />}
        minWidth="760px"
      />
    </div>
  )
}

export default RecycleBin
