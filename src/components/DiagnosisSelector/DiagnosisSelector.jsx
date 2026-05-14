import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  diagnosisLabelKey,
  formatDiagnosisDetails,
  formatDiagnosisText,
  getDiagnosisSelections,
  normalizeDiagnosisSelection,
  searchDiagnosisCatalog,
} from '../../services/diagnosisCatalogService'
import './DiagnosisSelector.css'

const DEFAULT_MAX_DIAGNOSES = 10
const SEARCH_LIMIT = 50
const SEARCH_DEBOUNCE_MS = 180

const normalize = (value) => String(value || '').trim()

const DiagnosisSelector = ({
  id,
  value,
  details,
  onChange,
  maxDiagnoses = DEFAULT_MAX_DIAGNOSES,
  placeholder = 'Search diagnosis by name or ICD-10 code',
}) => {
  const [options, setOptions] = useState([])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const selected = useMemo(() => getDiagnosisSelections(value, details), [value, details])
  const selectedKeys = useMemo(() => new Set(selected.map(diagnosisLabelKey)), [selected])
  const selectedLabels = useMemo(() => selected.map((diagnosis) => diagnosis.label), [selected])
  const selectedSignature = useMemo(() => selectedKeys.size ? [...selectedKeys].sort().join('|') : '', [selectedKeys])

  useEffect(() => {
    if (!open || selected.length >= maxDiagnoses) {
      return undefined
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError('')
      searchDiagnosisCatalog(query, {
        limit: SEARCH_LIMIT,
        excludedLabels: selectedLabels,
      })
        .then((results) => {
          if (!cancelled) setOptions(results)
        })
        .catch((searchError) => {
          if (!cancelled) {
            setOptions([])
            setError(searchError.message || 'Unable to load diagnosis catalog.')
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, query.trim() ? SEARCH_DEBOUNCE_MS : 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query, selected.length, selectedLabels, selectedSignature, maxDiagnoses])

  const updateSelected = (nextSelected) => {
    const normalized = formatDiagnosisDetails(nextSelected.slice(0, maxDiagnoses))
    onChange(formatDiagnosisText(normalized), normalized)
  }

  const addDiagnosis = (diagnosis) => {
    const nextDiagnosis = normalizeDiagnosisSelection(
      typeof diagnosis === 'string'
        ? { label: diagnosis, source: 'Custom', custom: true }
        : diagnosis
    )

    if (!nextDiagnosis.label) return
    if (selectedKeys.has(diagnosisLabelKey(nextDiagnosis))) {
      setQuery('')
      return
    }
    if (selected.length >= maxDiagnoses) {
      setError(`Select no more than ${maxDiagnoses} diagnoses on one claim.`)
      return
    }
    setError('')
    updateSelected([...selected, nextDiagnosis])
    setQuery('')
    setOpen(false)
  }

  const removeDiagnosis = (diagnosis) => {
    setError('')
    updateSelected(selected.filter((item) => diagnosisLabelKey(item) !== diagnosisLabelKey(diagnosis)))
  }

  const canAddCustom = query.trim() && !selectedKeys.has(diagnosisLabelKey(query))

  return (
    <div className="diagnosis-selector">
      {selected.length > 0 && (
        <div className="diagnosis-selected-list">
          {selected.map((diagnosis) => (
            <span className="diagnosis-chip" key={`${diagnosis.source}-${diagnosis.code}-${diagnosis.label}`}>
              <span className="diagnosis-chip-text">
                <span>{diagnosis.label}</span>
                {(diagnosis.code || diagnosis.source) && (
                  <small>{[diagnosis.code, diagnosis.source].filter(Boolean).join(' - ')}</small>
                )}
              </span>
              <button type="button" onClick={() => removeDiagnosis(diagnosis)} aria-label={`Remove ${diagnosis.label}`}>
                <X size={14} strokeWidth={2.4} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div
        className="diagnosis-search-wrap"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }}
      >
        <input
          id={id}
          className="form-input diagnosis-search-input"
          type="text"
          value={query}
          placeholder={selected.length >= maxDiagnoses ? `Maximum ${maxDiagnoses} diagnoses selected` : placeholder}
          disabled={selected.length >= maxDiagnoses}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (options[0]) addDiagnosis(options[0])
              else addDiagnosis(query)
            }
          }}
        />
        {open && selected.length < maxDiagnoses && (
          <div className="diagnosis-options" role="listbox">
            {loading && <div className="diagnosis-option muted">Loading diagnoses...</div>}
            {!loading && error && <div className="diagnosis-option error">{error}</div>}
            {!loading && !error && options.map((option) => (
              <button
                type="button"
                className="diagnosis-option"
                key={`${option.source}-${option.code}-${option.label}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addDiagnosis(option)}
              >
                <strong>{option.label}</strong>
                <span>{[option.code, option.source].filter(Boolean).join(' - ')}</span>
              </button>
            ))}
            {!loading && !error && canAddCustom && (
              <button
                type="button"
                className="diagnosis-option diagnosis-option-custom"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addDiagnosis(query)}
              >
                Add "{normalize(query)}"
              </button>
            )}
            {!loading && !error && !options.length && !canAddCustom && (
              <div className="diagnosis-option muted">Type to search ICD-10 and Ghana STG diagnoses.</div>
            )}
          </div>
        )}
      </div>
      <input type="hidden" value={value || ''} readOnly />
      <div className="diagnosis-count">{selected.length}/{maxDiagnoses} selected</div>
    </div>
  )
}

export default DiagnosisSelector
