export const GHANA_REGIONS = [
  'Ahafo',
  'Ashanti',
  'Bono',
  'Bono East',
  'Central',
  'Eastern',
  'Greater Accra',
  'North East',
  'Northern',
  'Oti',
  'Savannah',
  'Upper East',
  'Upper West',
  'Volta',
  'Western',
  'Western North',
]

const normalizeRegionKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const REGION_BY_KEY = new Map(GHANA_REGIONS.map((region) => [normalizeRegionKey(region), region]))

export const normalizeGhanaRegion = (value) => {
  const normalized = String(value || '').trim()
  return REGION_BY_KEY.get(normalizeRegionKey(normalized)) || normalized
}
