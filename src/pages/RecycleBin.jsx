import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useNotification } from '../context/NotificationContext'
import { formatAppDateTime } from '../utils/date'
import {
  getDeletedRecords,
  permanentlyDeleteRecord,
  restoreDeletedRecord,
} from '../services/recycleBinService'
import './RecycleBin.css'

const TYPE_LABELS = {
  inventory_drug: 'Inventory item',
  nhis_claim: 'NHIS claim',
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
    if (!window.confirm(`Restore ${record.display_name}?`)) return
    try {
      setBusyId(record.id)
      await restoreDeletedRecord(record.id)
      await load()
      notify(`${record.display_name} restored.`, 'success')
    } catch (restoreError) {
      notify(restoreError.message || 'Unable to restore this record.', 'error')
    } finally {
      setBusyId('')
    }
  }

  const removePermanently = async (record) => {
    if (!window.confirm(`Permanently delete ${record.display_name}? This cannot be undone.`)) return
    try {
      setBusyId(record.id)
      await permanentlyDeleteRecord(record.id)
      await load()
      notify(`${record.display_name} permanently deleted.`, 'success')
    } catch (deleteError) {
      notify(deleteError.message || 'Unable to permanently delete this record.', 'error')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="recycle-bin">
      <div className="page-header">
        <div>
          <h1 className="page-title">Recycle Bin</h1>
          <p className="page-subtitle">Restore deleted inventory items and NHIS claims, or remove them permanently.</p>
        </div>
      </div>
      {error && <div className="nhis-alert" role="alert">{error}</div>}
      <div className="recycle-bin-card">
        {loading ? (
          <div className="recycle-bin-empty">Loading deleted records…</div>
        ) : records.length === 0 ? (
          <div className="recycle-bin-empty">The Recycle Bin is empty.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Type</th><th>Name / Number</th><th>Deleted</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>{TYPE_LABELS[record.entity_type] || record.entity_type}</td>
                  <td><strong>{record.display_name}</strong></td>
                  <td>{formatAppDateTime(record.deleted_at)}</td>
                  <td className="recycle-bin-actions">
                    <button className="btn btn-secondary btn-sm" disabled={busyId === record.id} onClick={() => restore(record)}>
                      <RotateCcw size={14} /> Restore
                    </button>
                    <button className="btn btn-danger btn-sm" disabled={busyId === record.id} onClick={() => removePermanently(record)}>
                      <Trash2 size={14} /> Delete Permanently
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default RecycleBin
