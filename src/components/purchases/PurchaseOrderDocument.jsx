import { X, Printer } from 'lucide-react'
import { formatAppDate } from '../../utils/date'

const money = (value) =>
  `GHS ${Number(value || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// The printable purchase order a supplier receives by print, WhatsApp, email or phone
// follow-up. No supplier portal is assumed. Printing hides everything except this sheet
// (see the @media print rules in Purchases.css).
export default function PurchaseOrderDocument({ purchase, facility = {}, supplier = null, createdBy = '', onClose }) {
  const items = purchase.purchase_items || []
  const estimatedTotal = items.reduce(
    (sum, item) => sum + (Number.parseFloat(item.quantity) || 0) * (Number.parseFloat(item.unit_cost) || 0),
    0
  )
  const facilityAddress = [facility.address, facility.city, facility.region].filter(Boolean).join(', ')
  const supplierName = purchase.supplier_name || supplier?.name || '—'

  return (
    <div className="modal-overlay po-print-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-panel modal-panel--po" aria-label="Purchase order preview">
        <div className="modal-header po-print-hide">
          <h2>Purchase order {purchase.purchase_number}</h2>
          <div className="po-print-buttons">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>
              <Printer size={16} /> Print
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        <article className="po-print-sheet">
          <header className="po-sheet-header">
            <div>
              <h1>{facility.name || 'Facility'}</h1>
              {facilityAddress && <p>{facilityAddress}</p>}
              {(facility.phone || facility.email) && (
                <p>{[facility.phone, facility.email].filter(Boolean).join(' · ')}</p>
              )}
            </div>
            <div className="po-sheet-title">
              <h2>PURCHASE ORDER</h2>
              <p><strong>PO No:</strong> {purchase.purchase_number}</p>
              <p><strong>Order date:</strong> {formatAppDate(purchase.ordered_at || purchase.purchase_date)}</p>
              {createdBy && <p><strong>Created by:</strong> {createdBy}</p>}
            </div>
          </header>

          <section className="po-sheet-parties">
            <div>
              <h3>Supplier</h3>
              <p><strong>{supplierName}</strong></p>
              {supplier?.contact_person && <p>{supplier.contact_person}</p>}
              {supplier?.phone && <p>{supplier.phone}</p>}
              {supplier?.email && <p>{supplier.email}</p>}
              {supplier?.address && <p>{supplier.address}</p>}
            </div>
            {purchase.invoice_number && (
              <div>
                <h3>Reference</h3>
                <p>{purchase.invoice_number}</p>
              </div>
            )}
          </section>

          <table className="po-sheet-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Medicine</th>
                <th>Unit</th>
                <th className="num">Quantity</th>
                <th className="num">Est. unit cost</th>
                <th className="num">Est. total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={item.id || index}>
                  <td>{index + 1}</td>
                  <td>
                    {item.drug_name}
                    {item.generic_name && <div className="po-sheet-subtext">{item.generic_name}</div>}
                  </td>
                  <td>{item.unit || '—'}</td>
                  <td className="num">{item.quantity}</td>
                  <td className="num">{money(item.unit_cost)}</td>
                  <td className="num">{money((Number.parseFloat(item.quantity) || 0) * (Number.parseFloat(item.unit_cost) || 0))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="num"><strong>Estimated total</strong></td>
                <td className="num"><strong>{money(estimatedTotal)}</strong></td>
              </tr>
            </tfoot>
          </table>

          {purchase.notes && (
            <section className="po-sheet-notes">
              <h3>Notes</h3>
              <p>{purchase.notes}</p>
            </section>
          )}

          <section className="po-sheet-signatures">
            <div><span>Prepared by</span></div>
            <div><span>Approved by</span></div>
            <div><span>Supplier acknowledgement</span></div>
          </section>
          <p className="po-sheet-footnote">Prices are estimates and may change on the supplier's invoice.</p>
        </article>
      </div>
    </div>
  )
}
