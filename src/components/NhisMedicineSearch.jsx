import { useMemo, useRef, useState } from 'react'
import { Download, Pill, Search, X } from 'lucide-react'
import writeExcelFile from 'write-excel-file/browser'
import { searchMedicineLines } from '../services/nhisMedicineSearchService'
import { logAuditEvent } from '../services/auditService'
import {
  allSearchTerms,
  buildMedicineSearchFileName,
  buildMedicineSearchResult,
  buildMedicineSearchSheets,
  describeMedicineDates,
  describeMedicineName,
  describeSources,
  formatReportDate,
  formatSearchPeriod,
  loadSavedMedicineList,
  monthRangeToDates,
  parseMedicineSearch,
  saveMedicineList,
} from '../utils/nhisMedicineSearch'
import { buildMonthOptions, formatReportMonth } from '../utils/nhisMonthlyReports'
import './NhisMonthlyReports.css'
import './NhisMedicineSearch.css'

const PAGE_SIZE = 50
const money = (value) => Number(value || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const quantity = (value) => Number(value || 0).toLocaleString('en-GH', { maximumFractionDigits: 2 })
const getStorage = () => { try { return window.localStorage } catch { return null } }
const patientName = (patient) => [patient.surname, patient.otherNames].filter(Boolean).join(' ') || 'Unnamed patient'

const SOURCE_CHOICES = [
  { value: 'all', label: 'NHIS claims and cash sales' },
  { value: 'nhis', label: 'NHIS claims only' },
  { value: 'cash', label: 'Cash sales only' },
]

const currentMonth = () => buildMonthOptions('')[0]
const twoMonthsBack = () => buildMonthOptions('')[2]

export default function NhisMedicineSearch({
  organizationId = '',
  facilityName = '',
  searchMedicines = searchMedicineLines,
  recordAudit = logAuditEvent,
  onClose,
  notify = () => {},
}) {
  const [listText, setListText] = useState(() => loadSavedMedicineList(getStorage(), organizationId))
  const [fromMonth, setFromMonth] = useState(twoMonthsBack)
  const [toMonth, setToMonth] = useState(currentMonth)
  const [source, setSource] = useState('all')
  const [searched, setSearched] = useState(null) // { groups, result, fromMonth, toMonth }
  const [ignored, setIgnored] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [page, setPage] = useState(0)
  const searchToken = useRef(0)

  const fromOptions = useMemo(() => buildMonthOptions(fromMonth), [fromMonth])
  const toOptions = useMemo(() => buildMonthOptions(toMonth), [toMonth])
  const parsed = useMemo(() => parseMedicineSearch(listText), [listText])

  const result = searched?.result
  const patients = result?.patients || []
  const pageCount = Math.max(1, Math.ceil(patients.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const visible = patients.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE)

  const runSearch = async (event) => {
    event?.preventDefault()
    if (loading) return
    const { groups, ignored: skipped, tooMany } = parseMedicineSearch(listText)
    const range = monthRangeToDates(fromMonth, toMonth)
    setIgnored(skipped)
    setError('')
    if (!groups.length) {
      setSearched(null)
      setError('Type at least one medicine name of three letters or more.')
      return
    }
    if (!range) {
      setError('Choose the months to search.')
      return
    }
    if (tooMany) setError('')

    const token = searchToken.current + 1
    searchToken.current = token
    setLoading(true)
    setSearched(null)
    setPage(0)
    saveMedicineList(getStorage(), organizationId, listText)
    try {
      const lines = await searchMedicines({
        organizationId, fromDate: range.fromDate, toDate: range.toDate, terms: allSearchTerms(groups), source,
      })
      if (token !== searchToken.current) return
      setSearched({
        groups, source, fromMonth: range.fromMonth, toMonth: range.toMonth,
        result: buildMedicineSearchResult({ lines, groups }),
      })
    } catch (searchError) {
      if (token !== searchToken.current) return
      setError(searchError?.message || 'The medicine search could not be completed.')
    } finally {
      if (token === searchToken.current) setLoading(false)
    }
  }

  const download = async () => {
    if (downloading || !searched) return
    setDownloading(true)
    try {
      const sheets = buildMedicineSearchSheets({
        result: searched.result, groups: searched.groups, facilityName,
        fromMonth: searched.fromMonth, toMonth: searched.toMonth, source: searched.source,
      })
      await writeExcelFile(sheets, { fontFamily: 'Calibri', fontSize: 11 })
        .toFile(buildMedicineSearchFileName(facilityName, searched.fromMonth, searched.toMonth))
      notify('Medicine search downloaded.', 'success')
      try {
        // Counts and months only: no patient or medicine details go into the audit trail.
        await recordAudit({
          eventType: 'nhis_medicine_search_export',
          entityType: 'nhis_claims',
          action: 'export',
          details: {
            organization_id: organizationId,
            medicines_searched: searched.groups.length,
            source: searched.source,
            patients: searched.result.totals.patients,
            from_month: searched.fromMonth,
            to_month: searched.toMonth,
          },
        })
      } catch {
        // The file is already saved; a missing audit line must not turn that into an error.
      }
    } catch (downloadError) {
      notify(downloadError?.message || 'The file could not be created.', 'error')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="modal-overlay" role="presentation">
      <div className="nmr-panel nms-panel" role="dialog" aria-modal="true" aria-labelledby="nms-title">
        <div className="modal-header">
          <h2 id="nms-title"><Pill size={18} /> Medicine search</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>

        <form className="nmr-body" onSubmit={runSearch}>
          <label className="nmr-field nmr-field--grow">
            <span>Medicines to look for</span>
            <textarea
              className="form-input nms-list"
              rows={3}
              value={listText}
              placeholder="Paclitaxel, Docetaxel, Xeloda (Capecitabine), Anastrozole (Arimidex), Tamoxifen"
              onChange={(event) => setListText(event.target.value)}
            />
          </label>
          <p className="nmr-note">
            Separate medicines with commas or new lines. Put the other name of a medicine in brackets, like
            <strong> Xeloda (Capecitabine)</strong>, and a claim line with either name counts for it.
            {parsed.groups.length > 0 && <> Looking for <strong>{parsed.groups.length}</strong> medicine{parsed.groups.length === 1 ? '' : 's'}.</>}
          </p>

          <div className="nmr-controls">
            <label className="nmr-field">
              <span>From</span>
              <select className="form-input" value={fromMonth} onChange={(event) => setFromMonth(event.target.value)}>
                {fromOptions.map((option) => <option key={option} value={option}>{formatReportMonth(option)}</option>)}
              </select>
            </label>
            <label className="nmr-field">
              <span>To</span>
              <select className="form-input" value={toMonth} onChange={(event) => setToMonth(event.target.value)}>
                {toOptions.map((option) => <option key={option} value={option}>{formatReportMonth(option)}</option>)}
              </select>
            </label>
            <label className="nmr-field">
              <span>Look in</span>
              <select className="form-input" value={source} onChange={(event) => setSource(event.target.value)}>
                {SOURCE_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            </label>
            <button type="submit" className="btn btn-primary nms-go" disabled={loading}>
              <Search size={15} /> {loading ? 'Searching…' : 'Search'}
            </button>
          </div>

          {parsed.tooMany && (
            <p className="nmr-note nmr-note--warn" role="status">Only the first 20 medicines are searched.</p>
          )}
          {ignored.length > 0 && (
            <p className="nmr-note nmr-note--warn" role="status">
              Left out because the name is too short (three letters at least): {ignored.join(', ')}.
            </p>
          )}
          {loading && <p className="nmr-status" role="status">Searching claims. A long period can take a minute.</p>}
          {error && <p className="nmr-status nmr-status--error" role="alert">{error}</p>}

          {searched && !loading && (
            <>
              <div className="nmr-summary" aria-live="polite">
                <span>
                  <strong>{result.totals.patients}</strong> patient{result.totals.patients === 1 ? '' : 's'} ·{' '}
                  <strong>{result.totals.claims}</strong> claim{result.totals.claims === 1 ? '' : 's'} · GHS <strong>{money(result.totals.amount)}</strong>
                </span>
                <span>
                  {formatSearchPeriod(searched.fromMonth, searched.toMonth)} ·{' '}
                  {searched.source === 'cash' ? 'completed cash sales' : searched.source === 'nhis' ? 'served, submitted and paid claims' : 'served, submitted and paid claims and completed cash sales'}
                </span>
              </div>

              {result.walkInLines > 0 && (
                <p className="nmr-note nmr-note--warn" role="status">
                  {result.walkInLines} cash sale line{result.walkInLines === 1 ? '' : 's'} with no patient recorded {result.walkInLines === 1 ? 'was' : 'were'} left out, because there is no patient to list.
                </p>
              )}

              <div className="nmr-table-wrap nms-summary-wrap">
                <table className="nhis-table nmr-table">
                  <thead>
                    <tr>
                      <th>Medicine searched</th><th className="nmr-num">Patients</th><th className="nmr-num">Claims / sales</th>
                      <th className="nmr-num">Quantity given</th><th className="nmr-num">Amount (GHS)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.summary.map((entry) => (
                      <tr key={entry.label} className={entry.patients ? '' : 'nmr-row--left-out'}>
                        <td>{entry.label}</td>
                        <td className="nmr-num">{entry.patients}</td>
                        <td className="nmr-num">{entry.claims}</td>
                        <td className="nmr-num">{quantity(entry.quantity)}</td>
                        <td className="nmr-num">{money(entry.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {patients.length === 0 ? (
                <p className="nmr-status">No patient was given these medicines in {formatSearchPeriod(searched.fromMonth, searched.toMonth)}.</p>
              ) : (
                <div className="nmr-table-wrap">
                  <table className="nhis-table nmr-table">
                    <thead>
                      <tr>
                        <th>No.</th><th>Patient</th><th>Member no.</th><th>Medicines and dates given</th><th>Given via</th>
                        <th className="nmr-num">Claims / sales</th><th>Last given</th><th className="nmr-num">Amount (GHS)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((patient, index) => (
                        <tr key={patient.key}>
                          <td>{currentPage * PAGE_SIZE + index + 1}</td>
                          <td>{patientName(patient)}</td>
                          <td>{patient.memberNo || '-'}</td>
                          <td className="nms-meds">
                            {patient.medicines.map((medicine) => (
                              <div key={medicine.label}>
                                <strong>{describeMedicineName(medicine)}</strong>
                                <span className="nms-med-dates">{describeMedicineDates(medicine)}</span>
                              </div>
                            ))}
                          </td>
                          <td>{describeSources(patient.sources) || '-'}</td>
                          <td className="nmr-num">{patient.claimCount}</td>
                          <td>{formatReportDate(patient.lastDate) || '-'}</td>
                          <td className="nmr-num">{money(patient.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {patients.length > PAGE_SIZE && (
                <div className="nmr-pager">
                  <button type="button" className="btn btn-secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
                  <span>{currentPage * PAGE_SIZE + 1}-{Math.min((currentPage + 1) * PAGE_SIZE, patients.length)} of {patients.length}</span>
                  <button type="button" className="btn btn-secondary" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next</button>
                </div>
              )}
            </>
          )}
        </form>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" disabled={!searched || loading || downloading || patients.length === 0} onClick={download}>
            <Download size={15} /> {downloading ? 'Preparing…' : 'Download Excel'}
          </button>
        </div>
      </div>
    </div>
  )
}
