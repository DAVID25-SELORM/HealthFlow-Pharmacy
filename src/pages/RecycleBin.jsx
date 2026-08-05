import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
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
      <DataTable
        columns={columns}
        rows={records}
        getRowKey={(record) => record.id}
        loading={loading}
        loadingState={<LoadingState title="Loading deleted records" description="Checking recoverable records..." />}
        emptyState={<EmptyState title="The Recycle Bin is empty" description="Deleted inventory items and NHIS claims will appear here." />}
        minWidth="760px"
      />
    </div>
  )
}

export default RecycleBin
