import { useState } from 'react'
import { X } from 'lucide-react'
import GhanaRegionSelect from '../GhanaRegionSelect'
import { createBranch } from '../../services/branchService'

const BLANK = { name: '', code: '', phone: '', email: '', address: '', city: '', region: '' }

// Administrators and branch managers can add a branch here. The database function behind it also
// enforces the multi-branch switch and rejects duplicate names, so those rules cannot be skipped.
export default function AddBranchModal({ locked = false, onClose, onCreated }) {
  const [form, setForm] = useState(BLANK)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))

  const submit = async (event) => {
    event.preventDefault()
    if (locked || busy) return
    if (form.name.trim().length < 2) {
      setError('Enter a branch name of at least 2 characters.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const branch = await createBranch(form)
      await onCreated(branch)
    } catch (createError) {
      setError(createError.message || 'The branch could not be created.')
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-content stx-modal" onSubmit={submit} aria-label="Add a branch">
        <div className="modal-header">
          <h2>Add a branch</h2>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="stx-form">
          {locked && (
            <div className="stx-alert" role="alert">
              Multi-branch is not enabled for this pharmacy yet. Ask the platform administrator to enable it, then you can add more branches.
            </div>
          )}
          <div className="stx-branch-row">
            <label className="form-group"><span>Branch name *</span>
              <input value={form.name} onChange={set('name')} maxLength={120} required disabled={locked || busy} autoFocus />
            </label>
            <label className="form-group"><span>Code (optional)</span>
              <input value={form.code} onChange={set('code')} maxLength={50} placeholder="e.g. EAST" disabled={locked || busy} />
            </label>
          </div>
          <div className="stx-branch-row">
            <label className="form-group"><span>Phone</span>
              <input value={form.phone} onChange={set('phone')} maxLength={20} disabled={locked || busy} />
            </label>
            <label className="form-group"><span>Email</span>
              <input type="email" value={form.email} onChange={set('email')} maxLength={255} disabled={locked || busy} />
            </label>
          </div>
          <label className="form-group"><span>Address</span>
            <input value={form.address} onChange={set('address')} maxLength={500} disabled={locked || busy} />
          </label>
          <div className="stx-branch-row">
            <label className="form-group"><span>City / town</span>
              <input value={form.city} onChange={set('city')} maxLength={100} disabled={locked || busy} />
            </label>
            <GhanaRegionSelect value={form.region} onChange={set('region')} disabled={locked || busy} />
          </div>
          {error && <div className="stx-alert" role="alert">{error}</div>}
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={locked || busy}>{busy ? 'Creating...' : 'Create branch'}</button>
        </div>
      </form>
    </div>
  )
}
