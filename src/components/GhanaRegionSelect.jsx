import { GHANA_REGIONS, normalizeGhanaRegion } from '../utils/ghanaRegions'

const GhanaRegionSelect = ({ value, placeholder = 'Select region', ...props }) => {
  const normalizedValue = normalizeGhanaRegion(value)
  const hasLegacyValue = normalizedValue && !GHANA_REGIONS.includes(normalizedValue)

  return (
    <select {...props} value={normalizedValue}>
      <option value="">{placeholder}</option>
      {hasLegacyValue && <option value={normalizedValue}>{normalizedValue}</option>}
      {GHANA_REGIONS.map((region) => (
        <option key={region} value={region}>
          {region}
        </option>
      ))}
    </select>
  )
}

export default GhanaRegionSelect
