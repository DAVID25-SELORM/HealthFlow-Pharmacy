import { useMemo, useState } from 'react'
import { FileSpreadsheet, X } from 'lucide-react'
import { useNotification } from '../../context/NotificationContext'
import {
  PURCHASE_IMPORT_ROW_STATUS,
  finalizePurchaseImportItem,
  groupDuplicatePurchaseImportRows,
  purchaseImportRowsToObjects,
  validatePurchaseImportRow,
} from '../../utils/purchaseItemImport'
import { downloadPurchaseImportTemplate, readPurchaseImportRows } from '../../utils/purchaseItemImportFile'

const STATUS_LABEL = {
  [PURCHASE_IMPORT_ROW_STATUS.VALID]: 'Valid',
  [PURCHASE_IMPORT_ROW_STATUS.WARNING]: 'Needs a look',
  [PURCHASE_IMPORT_ROW_STATUS.INVALID]: 'Invalid',
}

let rowKeySequence = 0
const nextRowKey = () => { rowKeySequence += 1; return rowKeySequence }

/**
 * Bulk-import step for the New Purchase Order modal. Parses an uploaded .xlsx/.csv into rows, validates and
 * matches each one against existing inventory, lets the user resolve or remove problem rows, then — only once the
 * user presses "Import" — hands the finalized rows to onImport(items) to append to the purchase draft's own
 * lineItems, exactly as if they had been typed in one at a time. This panel never touches the database: it has no
 * access to save/receive/complete, so it cannot change stock or create a purchase by itself.
 */
export default function PurchaseItemImportPanel({
  drugs = [],
  allowedUnits = [],
  fallbackUnit = 'tablet',
  calcDiscountValue,
  calcNetTotal,
  fmtCurrency,
  onImport,
}) {
  const { notify } = useNotification()
  const [rows, setRows] = useState([])
  const [fileError, setFileError] = useState('')
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [matchingRowKey, setMatchingRowKey] = useState(null)
  const [matchSearch, setMatchSearch] = useState('')
  const [combineDuplicates, setCombineDuplicates] = useState(true)

  const handleFile = async (file) => {
    setFileError('')
    setRows([])
    setFileName(file?.name || '')
    if (!file) return
    setParsing(true)
    try {
      const sheetRows = await readPurchaseImportRows(file)
      const objects = purchaseImportRowsToObjects(sheetRows)
      setRows(
        objects.map((raw) => {
          const result = validatePurchaseImportRow(raw, { drugs, allowedUnits, fallbackUnit })
          return { key: nextRowKey(), raw, ...result }
        })
      )
    } catch (error) {
      setFileError(error.message || 'Could not read this file.')
    } finally {
      setParsing(false)
    }
  }

  const removeRow = (key) => setRows((current) => current.filter((row) => row.key !== key))

  const applyMatch = (key, drug) => {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row
        // Adopt the chosen drug's own name too — otherwise re-validation would look up the original (mistyped)
        // name again and immediately re-flag the row as unmatched.
        const nextRaw = { ...row.raw, drugName: drug.name, brandName: drug.brand_name || row.raw.brandName, genericName: drug.generic_name || row.raw.genericName }
        const result = validatePurchaseImportRow(nextRaw, { drugs, allowedUnits, fallbackUnit })
        return { ...row, raw: nextRaw, ...result, item: { ...result.item, drugId: drug.id } }
      })
    )
    setMatchingRowKey(null)
    setMatchSearch('')
  }

  const matchCandidatesFor = (query) => {
    const term = query.trim().toLowerCase()
    if (!term) return drugs.slice(0, 15)
    return drugs
      .filter((drug) => drug.name.toLowerCase().includes(term) || (drug.brand_name || '').toLowerCase().includes(term) || (drug.generic_name || '').toLowerCase().includes(term))
      .slice(0, 15)
  }

  const importableRows = useMemo(() => rows.filter((row) => row.status !== PURCHASE_IMPORT_ROW_STATUS.INVALID), [rows])
  const invalidCount = rows.length - importableRows.length
  const duplicateGroups = useMemo(() => groupDuplicatePurchaseImportRows(importableRows), [importableRows])
  const duplicateRowCount = duplicateGroups.reduce((sum, group) => sum + group.length, 0)

  const handleDownloadTemplate = async () => {
    setDownloading(true)
    try {
      await downloadPurchaseImportTemplate()
    } catch {
      notify('Could not generate the template file.', 'error')
    } finally {
      setDownloading(false)
    }
  }

  const handleImport = () => {
    if (!importableRows.length) return
    const finalize = (item) => finalizePurchaseImportItem(item, { calcDiscountValue, calcNetTotal })

    let itemsToAdd
    if (combineDuplicates && duplicateGroups.length) {
      const skipIndexes = new Set()
      duplicateGroups.forEach((group) => group.slice(1).forEach((index) => skipIndexes.add(index)))
      itemsToAdd = importableRows
        .map((row, index) => ({ row, index }))
        .filter(({ index }) => !skipIndexes.has(index))
        .map(({ row, index }) => {
          const group = duplicateGroups.find((candidate) => candidate[0] === index)
          if (!group) return finalize(row.item)
          const combinedQuantity = group.reduce((sum, groupIndex) => sum + importableRows[groupIndex].item.quantity, 0)
          return finalize({ ...row.item, quantity: combinedQuantity })
        })
    } else {
      itemsToAdd = importableRows.map((row) => finalize(row.item))
    }

    onImport(itemsToAdd, { totalRows: rows.length, validRows: itemsToAdd.length, invalidRows: invalidCount, fileName })
    setRows([])
    setFileName('')
    notify(`${itemsToAdd.length} item${itemsToAdd.length === 1 ? '' : 's'} added to this purchase from ${fileName || 'the file'}.`, 'success')
  }

  return (
    <div className="purchase-import-panel">
      <div className="purchase-import-toolbar">
        <button type="button" className="btn btn-secondary" onClick={handleDownloadTemplate} disabled={downloading}>
          <FileSpreadsheet size={16} /> {downloading ? 'Preparing…' : 'Download Template'}
        </button>
        <label className="btn btn-primary purchase-import-upload">
          Upload .xlsx / .csv
          <input
            type="file"
            accept=".xlsx,.csv,text/csv"
            hidden
            onChange={(event) => handleFile(event.target.files?.[0])}
            onClick={(event) => { event.target.value = '' }}
          />
        </label>
      </div>

      {parsing && <p className="purchase-import-status">Reading {fileName}…</p>}
      {fileError && <div className="purchases-alert" role="alert">{fileError}</div>}

      {rows.length > 0 && (
        <>
          <div className="purchase-import-summary">
            <span>{importableRows.length} of {rows.length} row{rows.length === 1 ? '' : 's'} ready to import</span>
            {invalidCount > 0 && (
              <span className="purchase-import-summary--invalid">
                {invalidCount} row{invalidCount === 1 ? '' : 's'} {invalidCount === 1 ? 'needs' : 'need'} attention and will not be imported
              </span>
            )}
          </div>

          {duplicateGroups.length > 0 && (
            <label className="checkbox-field purchase-import-duplicate-toggle">
              <input type="checkbox" checked={combineDuplicates} onChange={(event) => setCombineDuplicates(event.target.checked)} />
              <span>Combine {duplicateRowCount} rows that look identical (same product, batch, expiry, cost and discount) into one line each</span>
            </label>
          )}

          <div className="purchase-import-preview-wrap">
            <table className="purchase-import-preview-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Drug / Item</th>
                  <th>Unit</th>
                  <th>Qty</th>
                  <th>Unit Cost</th>
                  <th>Discount</th>
                  <th>Batch</th>
                  <th>Expiry</th>
                  <th>Net Total</th>
                  <th>Issue</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={`purchase-import-row purchase-import-row--${row.status}`}>
                    <td><span className={`purchase-import-badge purchase-import-badge--${row.status}`}>{STATUS_LABEL[row.status]}</span></td>
                    <td>
                      <div className="item-name">{row.item.drugName || row.raw.drugName || '—'}</div>
                      {row.matchStatus === 'unmatched' && matchingRowKey !== row.key && (
                        <button type="button" className="purchase-import-link" onClick={() => { setMatchingRowKey(row.key); setMatchSearch(row.item.drugName) }}>
                          Match Item
                        </button>
                      )}
                      {matchingRowKey === row.key && (
                        <div className="purchase-import-match">
                          <input
                            className="form-input"
                            autoFocus
                            placeholder="Search inventory…"
                            value={matchSearch}
                            onChange={(event) => setMatchSearch(event.target.value)}
                          />
                          <div className="purchase-import-match-results">
                            {matchCandidatesFor(matchSearch).map((drug) => (
                              <button key={drug.id} type="button" className="drug-dropdown-item" onClick={() => applyMatch(row.key, drug)}>
                                <span className="drug-name">{drug.name}</span>
                                <span className="drug-meta">{drug.unit}</span>
                              </button>
                            ))}
                            {matchCandidatesFor(matchSearch).length === 0 && <p className="purchase-import-status">No matching medicine found.</p>}
                          </div>
                          <button type="button" className="btn btn-secondary" onClick={() => setMatchingRowKey(null)}>Cancel</button>
                        </div>
                      )}
                    </td>
                    <td>{row.item.unit}</td>
                    <td>{row.item.quantity || '—'}</td>
                    <td>{fmtCurrency ? fmtCurrency(row.item.unitCost) : row.item.unitCost}</td>
                    <td>{Number(row.item.discountPercent || 0).toFixed(2)}%</td>
                    <td>{row.item.batchNumber || '—'}</td>
                    <td>{row.item.expiryDate || '—'}</td>
                    <td>{fmtCurrency ? fmtCurrency(finalizePurchaseImportItem(row.item, { calcDiscountValue, calcNetTotal }).netTotal) : ''}</td>
                    <td className="purchase-import-issues">{row.issues.join(' ')}</td>
                    <td>
                      <button type="button" className="action-btn action-btn--cancel" onClick={() => removeRow(row.key)} aria-label="Remove row">
                        <X size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="entry-panel-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { setRows([]); setFileName('') }}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" disabled={!importableRows.length} onClick={handleImport}>
              Import {importableRows.length} Valid Row{importableRows.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
