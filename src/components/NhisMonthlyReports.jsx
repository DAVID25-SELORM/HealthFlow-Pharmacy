import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileSpreadsheet, X } from 'lucide-react'
import writeExcelFile from 'write-excel-file/browser'
import { getNhisClaimsForPeriod } from '../services/nhisService'
import {
  buildClaimSummarySheets,
  buildNumberedReportClaims,
  buildMonthOptions,
  buildReportFileName,
  buildWorkingSheet,
  cleanAttachmentNumber,
  countClaimsLeftOut,
  formatReportDate,
  formatReportMonth,
  loadReportSelection,
  saveReportSelection,
} from '../utils/nhisMonthlyReports'
import './NhisMonthlyReports.css'

const PAGE_SIZE = 50
const money = (value) => Number(value || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const getStorage = () => { try { return window.localStorage } catch { return null } }

const claimName = (claim) => [claim.surname, claim.other_names].filter(Boolean).join(' ') || 'Unnamed patient'

export default function NhisMonthlyReports({
  organizationId = '',
  facilityName = '',
  initialMonth = '',
  loadClaims = getNhisClaimsForPeriod,
  onClose,
  notify = () => {},
}) {
  const [month, setMonth] = useState(initialMonth || new Date().toISOString().slice(0, 7))
  const [claims, setClaims] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [excludedIds, setExcludedIds] = useState([])
  const [attachmentNumbers, setAttachmentNumbers] = useState({})
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [downloading, setDownloading] = useState('')
  const loadToken = useRef(0)
  // Set only after a month's saved choices have been read, so the first render never overwrites them.
  const selectionReady = useRef(false)

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return undefined
    const token = ++loadToken.current
    selectionReady.current = false
    setLoading(true)
    setLoadError('')
    setClaims([])
    setPage(0)
    setSearch('')
    const saved = loadReportSelection(getStorage(), organizationId, month)
    setExcludedIds(saved.excludedIds)
    setAttachmentNumbers(saved.attachmentNumbers)
    ;(async () => {
      try {
        const rows = await loadClaims({ mode: 'month', yearMonth: month, organizationId })
        if (token !== loadToken.current) return
        setClaims(Array.isArray(rows) ? rows : [])
        selectionReady.current = true
      } catch (error) {
        if (token !== loadToken.current) return
        setLoadError(error?.message || 'The claims could not be loaded.')
      } finally {
        if (token === loadToken.current) setLoading(false)
      }
    })()
    return () => { loadToken.current += 1 }
  }, [month, organizationId, loadClaims])

  useEffect(() => {
    if (!selectionReady.current) return
    saveReportSelection(getStorage(), organizationId, month, { excludedIds, attachmentNumbers })
  }, [excludedIds, attachmentNumbers, organizationId, month])

  const numbered = useMemo(() => buildNumberedReportClaims(claims), [claims])
  const leftOut = useMemo(() => countClaimsLeftOut(claims), [claims])
  const excludedSet = useMemo(() => new Set(excludedIds), [excludedIds])
  const includedCount = numbered.filter(({ claim }) => !excludedSet.has(String(claim.id))).length
  const totalAmount = numbered.reduce((sum, { amounts }) => sum + amounts.pharmacy, 0)

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return numbered
    return numbered.filter(({ claim }) => [
      claim.surname, claim.other_names, claim.member_no, claim.ccc_no, claim.folder_no, claim.claim_number,
      attachmentNumbers[claim.id],
    ].filter(Boolean).join(' ').toLowerCase().includes(query))
  }, [numbered, search, attachmentNumbers])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE)
  const monthLabel = formatReportMonth(month)
  const monthOptions = useMemo(() => buildMonthOptions(month), [month])

  const toggleClaim = useCallback((id) => {
    const key = String(id)
    setExcludedIds((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))
  }, [])

  const setAttachment = useCallback((id, value) => {
    setAttachmentNumbers((current) => ({ ...current, [id]: cleanAttachmentNumber(value) }))
  }, [])

  const download = async (kind) => {
    if (downloading) return
    setDownloading(kind)
    try {
      const built = kind === 'working'
        ? buildWorkingSheet({ claims, facilityName, yearMonth: month, excludedIds, attachmentNumbers })
        : buildClaimSummarySheets({ claims, facilityName, yearMonth: month })
      await writeExcelFile(built.sheets, { fontFamily: 'Calibri', fontSize: 11 })
        .toFile(buildReportFileName(kind, facilityName, month))
      notify(kind === 'working' ? 'Working sheet downloaded.' : 'Claim summary downloaded.', 'success')
    } catch (error) {
      notify(error?.message || 'The file could not be created.', 'error')
    } finally {
      setDownloading('')
    }
  }

  return (
    <div className="modal-overlay" role="presentation">
      <div className="nmr-panel" role="dialog" aria-modal="true" aria-labelledby="nmr-title">
        <div className="modal-header">
          <h2 id="nmr-title"><FileSpreadsheet size={18} /> Monthly claim reports</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="nmr-body">
          <div className="nmr-controls">
            <label className="nmr-field">
              <span>Month</span>
              <select className="form-input" value={month} onChange={(event) => setMonth(event.target.value)}>
                {monthOptions.map((option) => (
                  <option key={option} value={option}>{formatReportMonth(option)}</option>
                ))}
              </select>
            </label>
            <label className="nmr-field nmr-field--grow">
              <span>Find a claim</span>
              <input
                type="search"
                className="form-input"
                value={search}
                placeholder="Name, member number, CCC, folder or attachment number"
                onChange={(event) => { setSearch(event.target.value); setPage(0) }}
              />
            </label>
          </div>

          <p className="nmr-note">
            The <strong>claim summary</strong> lists every served, submitted or paid claim for {monthLabel || 'the month'}, laid out like the
            NHIA CLAIM-it summary. The <strong>working sheet</strong> lists only the claims ticked below; each keeps its summary number, so a
            claim you leave out leaves a gap. Ticks and attachment numbers are remembered in this browser for this month.
          </p>
          {leftOut > 0 && (
            <p className="nmr-note nmr-note--warn" role="status">
              {leftOut} other claim{leftOut === 1 ? '' : 's'} this month {leftOut === 1 ? 'is' : 'are'} not served or submitted yet, or
              {leftOut === 1 ? ' was' : ' were'} rejected, so {leftOut === 1 ? 'it is' : 'they are'} in neither file.
            </p>
          )}

          {loading && <p className="nmr-status" role="status">Loading claims. A big month can take a minute.</p>}
          {loadError && <p className="nmr-status nmr-status--error" role="alert">{loadError}</p>}

          {!loading && !loadError && (
            <>
              <div className="nmr-summary" aria-live="polite">
                <span><strong>{numbered.length}</strong> claim{numbered.length === 1 ? '' : 's'} · GHS <strong>{money(totalAmount)}</strong></span>
                <span><strong>{includedCount}</strong> ticked for the working sheet</span>
                <span className="nmr-summary__actions">
                  <button type="button" className="btn btn-secondary" disabled={!numbered.length} onClick={() => setExcludedIds([])}>Tick all</button>
                  <button type="button" className="btn btn-secondary" disabled={!numbered.length} onClick={() => setExcludedIds(numbered.map(({ claim }) => String(claim.id)))}>Untick all</button>
                </span>
              </div>

              {numbered.length === 0 ? (
                <p className="nmr-status">No served, submitted or paid claims for {monthLabel || 'this month'}.</p>
              ) : (
                <div className="nmr-table-wrap">
                  <table className="nhis-table nmr-table">
                    <thead>
                      <tr>
                        <th>Include</th><th>No.</th><th>Patient</th><th>Member no.</th><th>CCC</th>
                        <th>Date of service</th><th className="nmr-num">Amount (GHS)</th><th>Attachment no.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(({ number, claim, amounts }) => {
                        const included = !excludedSet.has(String(claim.id))
                        return (
                          <tr key={claim.id || number} className={included ? '' : 'nmr-row--left-out'}>
                            <td>
                              <input
                                type="checkbox"
                                checked={included}
                                aria-label={`Include ${claimName(claim)} in the working sheet`}
                                onChange={() => toggleClaim(claim.id)}
                              />
                            </td>
                            <td>{number}</td>
                            <td>{claimName(claim)}</td>
                            <td>{claim.member_no || '-'}</td>
                            <td>{claim.ccc_no || '-'}</td>
                            <td>{formatReportDate(claim.service_date_from) || '-'}</td>
                            <td className="nmr-num">{money(amounts.pharmacy)}</td>
                            <td>
                              <input
                                type="text"
                                className="form-input nmr-attachment"
                                inputMode="numeric"
                                maxLength={24}
                                value={attachmentNumbers[claim.id] || ''}
                                placeholder="e.g. 0380"
                                aria-label={`Attachment number for ${claimName(claim)}`}
                                onChange={(event) => setAttachment(claim.id, event.target.value)}
                              />
                            </td>
                          </tr>
                        )
                      })}
                      {visible.length === 0 && (
                        <tr><td colSpan={8}>No claim matches that search.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {filtered.length > PAGE_SIZE && (
                <div className="nmr-pager">
                  <button type="button" className="btn btn-secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
                  <span>{currentPage * PAGE_SIZE + 1}-{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                  <button type="button" className="btn btn-secondary" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next</button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading || !!loadError || !numbered.length || !!downloading}
            onClick={() => { void download('summary') }}
          >
            <Download size={14} /> {downloading === 'summary' ? 'Creating...' : 'Download claim summary'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={loading || !!loadError || !includedCount || !!downloading}
            onClick={() => { void download('working') }}
          >
            <Download size={14} /> {downloading === 'working' ? 'Creating...' : `Download working sheet (${includedCount})`}
          </button>
        </div>
      </div>
    </div>
  )
}
