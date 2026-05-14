import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import './DiagnosisSelector.css'

const DEFAULT_MAX_DIAGNOSES = 10
const MAX_VISIBLE_OPTIONS = 50
const MAX_RANKED_OPTIONS = 120

const normalize = (value) => String(value || '').trim()
const compact = (value) => normalize(value).toLowerCase().replace(/[^a-z0-9]/g, '')

const parseDiagnoses = (value) =>
  normalize(value)
    .split(/[;\n|]/)
    .map(normalize)
    .filter(Boolean)

const formatDiagnoses = (diagnoses) => diagnoses.join('\n')

const getOptionText = (option) =>
  [option?.code, option?.label, option?.source].filter(Boolean).join(' ')

const normalizeOption = (option) => {
  const label = normalize(option?.label)
  const code = normalize(option?.code)
  const source = normalize(option?.source)

  return {
    code,
    label,
    source,
    searchCode: code.toLowerCase(),
    searchKey: label.toLowerCase(),
    searchLabel: label.toLowerCase(),
    searchText: compact(getOptionText({ code, label, source })),
  }
}

const getOptionRank = (option, term, compactTerm) => {
  let rank = option.source === 'Ghana STG 2017' ? 0 : 20
  if (option.searchLabel === term) rank -= 12
  if (option.searchLabel.startsWith(term)) rank -= 8
  if (option.searchCode.startsWith(term)) rank -= 6
  if (compactTerm && option.searchText.includes(compactTerm)) rank -= 2
  return rank
}

const compareRankedOptions = (left, right) =>
  left.rank - right.rank ||
  left.option.searchLabel.localeCompare(right.option.searchLabel) ||
  left.option.searchCode.localeCompare(right.option.searchCode)

const collectRankedOption = (rankedOptions, candidate) => {
  if (rankedOptions.length < MAX_RANKED_OPTIONS) {
    rankedOptions.push(candidate)
    return
  }

  let worstIndex = 0
  for (let index = 1; index < rankedOptions.length; index += 1) {
    if (compareRankedOptions(rankedOptions[index], rankedOptions[worstIndex]) > 0) {
      worstIndex = index
    }
  }

  if (compareRankedOptions(candidate, rankedOptions[worstIndex]) < 0) {
    rankedOptions[worstIndex] = candidate
  }
}

const DiagnosisSelector = ({
  id,
  value,
  onChange,
  maxDiagnoses = DEFAULT_MAX_DIAGNOSES,
  placeholder = 'Search diagnosis by name or ICD-10 code',
}) => {
  const [catalog, setCatalog] = useState([])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const selected = useMemo(() => parseDiagnoses(value), [value])
  const selectedKeys = useMemo(() => new Set(selected.map((item) => item.toLowerCase())), [selected])

  const loadCatalog = async () => {
    if (catalog.length || loading) return
    try {
      setLoading(true)
      const module = await import('../../data/diagnosisCatalog.js')
      setCatalog((module.DIAGNOSIS_CATALOG || []).map(normalizeOption))
    } catch (loadError) {
      setError(loadError.message || 'Unable to load diagnosis catalog.')
    } finally {
      setLoading(false)
    }
  }

  const updateSelected = (nextSelected) => {
    onChange(formatDiagnoses(nextSelected.slice(0, maxDiagnoses)))
  }

  const addDiagnosis = (diagnosis) => {
    const label = normalize(diagnosis)
    if (!label) return
    if (selectedKeys.has(label.toLowerCase())) {
      setQuery('')
      return
    }
    if (selected.length >= maxDiagnoses) {
      setError(`Select no more than ${maxDiagnoses} diagnoses on one claim.`)
      return
    }
    setError('')
    updateSelected([...selected, label])
    setQuery('')
    setOpen(false)
  }

  const removeDiagnosis = (diagnosis) => {
    setError('')
    updateSelected(selected.filter((item) => item !== diagnosis))
  }

  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase()
    const compactTerm = compact(term)
    const source = catalog.filter((option) => !selectedKeys.has(option.searchKey))

    if (!term) {
      return source
        .filter((option) => option.source === 'Ghana STG 2017')
        .slice(0, MAX_VISIBLE_OPTIONS)
    }

    const rankedOptions = []
    source.forEach((option) => {
      const matches =
        option.searchLabel.includes(term) ||
        option.searchCode.includes(term) ||
        Boolean(compactTerm && option.searchText.includes(compactTerm))

      if (matches) {
        collectRankedOption(rankedOptions, {
          option,
          rank: getOptionRank(option, term, compactTerm),
        })
      }
    })

    return rankedOptions
      .sort(compareRankedOptions)
      .slice(0, MAX_VISIBLE_OPTIONS)
      .map((item) => item.option)
  }, [catalog, query, selectedKeys])

  const canAddCustom = query.trim() && !selectedKeys.has(query.trim().toLowerCase())

  return (
    <div className="diagnosis-selector">
      {selected.length > 0 && (
        <div className="diagnosis-selected-list">
          {selected.map((diagnosis) => (
            <span className="diagnosis-chip" key={diagnosis}>
              <span>{diagnosis}</span>
              <button type="button" onClick={() => removeDiagnosis(diagnosis)} aria-label={`Remove ${diagnosis}`}>
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
          onFocus={() => {
            setOpen(true)
            void loadCatalog()
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            void loadCatalog()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (filteredOptions[0]) addDiagnosis(filteredOptions[0].label)
              else addDiagnosis(query)
            }
          }}
        />
        {open && selected.length < maxDiagnoses && (
          <div className="diagnosis-options" role="listbox">
            {loading && <div className="diagnosis-option muted">Loading diagnoses...</div>}
            {!loading && error && <div className="diagnosis-option error">{error}</div>}
            {!loading && !error && filteredOptions.map((option) => (
              <button
                type="button"
                className="diagnosis-option"
                key={`${option.source}-${option.code}-${option.label}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addDiagnosis(option.label)}
              >
                <strong>{option.label}</strong>
                <span>{option.code} - {option.source}</span>
              </button>
            ))}
            {!loading && !error && canAddCustom && (
              <button
                type="button"
                className="diagnosis-option diagnosis-option-custom"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addDiagnosis(query)}
              >
                Add "{query.trim()}"
              </button>
            )}
            {!loading && !error && !filteredOptions.length && !canAddCustom && (
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
