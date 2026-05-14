import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { sanitizeSearchTerm } from '../utils/validation'

const DEFAULT_LIMIT = 50
const DATABASE_FETCH_LIMIT = 240
const MAX_STATIC_RANKED_OPTIONS = 180
const VALID_SOURCES = new Set(['Ghana STG 2017', 'ICD-10', 'Custom'])

const normalize = (value) => String(value || '').trim()
const compact = (value) => normalize(value).toLowerCase().replace(/[^a-z0-9]/g, '')
const labelKey = (value) => normalize(value).toLowerCase()

let bundledCatalogPromise = null

export const normalizeDiagnosisSelection = (diagnosis) => {
  const label = normalize(diagnosis?.label ?? diagnosis?.diagnosis ?? diagnosis?.name ?? diagnosis)
  const code = normalize(diagnosis?.code ?? diagnosis?.diagnosis_code)
  const requestedSource = normalize(diagnosis?.source ?? diagnosis?.diagnosis_source)
  const source = VALID_SOURCES.has(requestedSource)
    ? requestedSource
    : code
      ? 'ICD-10'
      : 'Custom'

  return {
    id: normalize(diagnosis?.id) || null,
    code,
    label,
    source,
    sourceVersion: normalize(diagnosis?.sourceVersion ?? diagnosis?.source_version) || null,
    custom: Boolean(diagnosis?.custom) || source === 'Custom',
  }
}

export const parseDiagnosisText = (value) =>
  normalize(value)
    .split(/[;\n|]/)
    .map(normalize)
    .filter(Boolean)

export const parseDiagnosisDetails = (value) => {
  const raw = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value)
        } catch {
          return []
        }
      })()
    : value

  if (!Array.isArray(raw)) return []

  return raw
    .map(normalizeDiagnosisSelection)
    .filter((diagnosis) => diagnosis.label)
}

export const getDiagnosisSelections = (diagnosisText, diagnosisDetails) => {
  const structured = parseDiagnosisDetails(diagnosisDetails)
  if (structured.length) return structured

  return parseDiagnosisText(diagnosisText).map((label) =>
    normalizeDiagnosisSelection({ label, source: 'Custom', custom: true })
  )
}

export const formatDiagnosisText = (diagnoses = []) =>
  parseDiagnosisDetails(diagnoses)
    .map((diagnosis) => diagnosis.label)
    .join('\n')

export const formatDiagnosisDetails = (diagnoses = []) =>
  parseDiagnosisDetails(diagnoses).map((diagnosis) => ({
    code: diagnosis.code || null,
    label: diagnosis.label,
    source: diagnosis.source,
    sourceVersion: diagnosis.sourceVersion || null,
    custom: Boolean(diagnosis.custom),
  }))

export const diagnosisLabelKey = (diagnosis) => labelKey(diagnosis?.label ?? diagnosis)

const getOptionText = (option) =>
  [option?.code, option?.label, option?.source].filter(Boolean).join(' ')

const normalizeCatalogOption = (option) => {
  const normalized = normalizeDiagnosisSelection(option)
  return {
    ...normalized,
    searchCode: normalized.code.toLowerCase(),
    searchLabel: normalized.label.toLowerCase(),
    searchText: compact(getOptionText(normalized)),
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
  if (rankedOptions.length < MAX_STATIC_RANKED_OPTIONS) {
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

const rankOptions = (options, query, { limit = DEFAULT_LIMIT, excludedLabels = [] } = {}) => {
  const term = normalize(query).toLowerCase()
  const compactTerm = compact(term)
  const excluded = new Set(excludedLabels.map(labelKey))
  const source = options.filter((option) => option.label && !excluded.has(labelKey(option.label)))

  if (!term) {
    return source
      .filter((option) => option.source === 'Ghana STG 2017')
      .slice(0, limit)
      .map(normalizeDiagnosisSelection)
  }

  const rankedOptions = []
  source.forEach((option) => {
    const normalized = option.searchLabel ? option : normalizeCatalogOption(option)
    const matches =
      normalized.searchLabel.includes(term) ||
      normalized.searchCode.includes(term) ||
      Boolean(compactTerm && normalized.searchText.includes(compactTerm))

    if (matches) {
      collectRankedOption(rankedOptions, {
        option: normalized,
        rank: getOptionRank(normalized, term, compactTerm),
      })
    }
  })

  return rankedOptions
    .sort(compareRankedOptions)
    .slice(0, limit)
    .map((item) => normalizeDiagnosisSelection(item.option))
}

const loadBundledCatalog = async () => {
  if (!bundledCatalogPromise) {
    bundledCatalogPromise = import('../data/diagnosisCatalog.js').then((module) =>
      (module.DIAGNOSIS_CATALOG || []).map(normalizeCatalogOption)
    )
  }

  return bundledCatalogPromise
}

const searchBundledDiagnosisCatalog = async (query, options) => {
  const catalog = await loadBundledCatalog()
  return rankOptions(catalog, query, options)
}

const sanitizeDiagnosisSearchTerm = (value) =>
  sanitizeSearchTerm(value)
    .replace(/[(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const isLikelyMissingDiagnosisCatalog = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    message.includes('diagnosis_catalog') ||
    message.includes('schema cache')
  )
}

const searchDatabaseDiagnosisCatalog = async (query, { limit = DEFAULT_LIMIT } = {}) => {
  if (!isSupabaseConfigured() || !supabase) return []
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return []

  const term = sanitizeDiagnosisSearchTerm(query).toLowerCase()
  const compactTerm = compact(term)
  const fetchLimit = Math.max(limit * 3, DATABASE_FETCH_LIMIT)
  let request = supabase
    .from('diagnosis_catalog')
    .select('id, code, label, source, source_version')
    .eq('is_active', true)
    .order('source', { ascending: true })
    .order('code', { ascending: true })
    .limit(fetchLimit)

  if (term) {
    const pattern = `%${term}%`
    const filters = [
      `code.ilike.${pattern}`,
      `label.ilike.${pattern}`,
      `source.ilike.${pattern}`,
      `search_text.ilike.${pattern}`,
    ]
    if (compactTerm) {
      filters.push(`search_compact.ilike.%${compactTerm}%`)
    }
    request = request.or(filters.join(','))
  } else {
    request = request.eq('source', 'Ghana STG 2017')
  }

  const { data, error } = await request
  if (error) {
    if (isLikelyMissingDiagnosisCatalog(error)) return []
    throw error
  }

  return (data || []).map(normalizeCatalogOption)
}

export const searchDiagnosisCatalog = async (query = '', options = {}) => {
  const limit = Number(options.limit) || DEFAULT_LIMIT
  const searchOptions = {
    ...options,
    limit,
  }

  try {
    const databaseOptions = await searchDatabaseDiagnosisCatalog(query, searchOptions)
    if (databaseOptions.length) {
      return rankOptions(databaseOptions, query, searchOptions)
    }
  } catch (error) {
    console.warn('Diagnosis catalog database search failed, using bundled fallback:', error)
  }

  return await searchBundledDiagnosisCatalog(query, searchOptions)
}
