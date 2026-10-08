import { useState } from 'react'
import { manageSupplier, updateSupplier } from '../services/purchasesService'
import { confirmAction } from '../utils/actionConfirmation'

export default function SupplierEditor({ supplier, onSaved, onDeleted, onClose }) {
  const [form, setForm] = useState({
    name: supplier.name || '', contactPerson: supplier.contact_person || '',
    phone: supplier.phone || '', email: supplier.email || '',
    address: supplier.address || '', notes: supplier.notes || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const changeStatus = async (action) => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      if (action === 'delete' && !(await confirmAction({
        title: 'Delete this supplier?', details: [{ label: 'Supplier', value: supplier.name }],
        warning: 'This permanently deletes the supplier. Suppliers with purchase history must be suspended instead.',
        confirmText: 'delete the supplier',
      }))) return
      const result = await manageSupplier(supplier.id, action)
      if (action === 'delete') onDeleted(result)
      else onSaved(result)
    } catch (failure) { setError(failure.message || 'Unable to change supplier.') }
    finally { setSaving(false) }
  }
  const save = async (event) => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError('')
    try { onSaved(await updateSupplier(supplier.id, form)) }
    catch (failure) { setError(failure.message || 'Unable to update supplier.') }
    finally { setSaving(false) }
  }
  return <div className="modal-overlay" style={{ zIndex: 1200 }}>
    <section className="modal-content" role="dialog" aria-modal="true" aria-labelledby="supplier-editor-title"
      style={{ width: 'min(560px, 95vw)', maxHeight: '90dvh', overflowY: 'auto', padding: '1.5rem', background: 'white', borderRadius: '8px' }}>
      <h2 id="supplier-editor-title">Edit supplier</h2>
      <p>Status: <strong>{supplier.is_active === false ? 'Suspended' : 'Active'}</strong></p>
      <form onSubmit={save}>
        {Object.entries({ name: 'Supplier name', contactPerson: 'Contact person', phone: 'Phone', email: 'Email', address: 'Address', notes: 'Notes' }).map(([field, label]) =>
          <label className="form-group" key={field} style={{ display: 'block' }}>{label}
            <input className="form-input" type={field === 'email' ? 'email' : 'text'} required={field === 'name'}
              value={form[field]} disabled={saving} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save supplier'}</button>
        </div>
      </form>
      <div className="form-actions" style={{ marginTop: '1rem' }}>
        <button type="button" className="btn btn-secondary" disabled={saving}
          onClick={() => changeStatus(supplier.is_active === false ? 'reactivate' : 'suspend')}>
          {supplier.is_active === false ? 'Reactivate supplier' : 'Suspend supplier'}
        </button>
        {onDeleted && <button type="button" className="btn btn-danger" disabled={saving} onClick={() => changeStatus('delete')}>
          Delete supplier
        </button>}
      </div>
    </section>
  </div>
}
