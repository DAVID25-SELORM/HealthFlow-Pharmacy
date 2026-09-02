export const FACILITY_THEME_UPDATED_EVENT = 'healthflow:facility-theme-updated'

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

export const DEFAULT_FACILITY_THEME = Object.freeze({
  primary: '#16a085',
  secondary: '#2c3e50',
  accent: '#f59e0b',
})

export const isValidThemeColor = (value) => HEX_COLOR_PATTERN.test(String(value || '').trim())

const mixHexColor = (hexColor, targetColor, weight) => {
  const source = hexColor.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16))
  const target = targetColor.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16))

  return `#${source
    .map((channel, index) => Math.round(channel + (target[index] - channel) * weight))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`
}

const relativeLuminance = (hexColor) => {
  const channels = hexColor
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    )

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

const contrastRatio = (firstColor, secondColor) => {
  const first = relativeLuminance(firstColor)
  const second = relativeLuminance(secondColor)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export const getReadableForeground = (backgroundColor) =>
  contrastRatio(backgroundColor, '#ffffff') >= contrastRatio(backgroundColor, '#111827')
    ? '#ffffff'
    : '#111827'

const getReadableGradientForeground = (firstColor, secondColor) => {
  const candidates = ['#ffffff', '#111827']
  return candidates.reduce((best, candidate) => {
    const score = Math.min(
      contrastRatio(firstColor, candidate),
      contrastRatio(secondColor, candidate)
    )
    return score > best.score ? { color: candidate, score } : best
  }, { color: '#ffffff', score: 0 }).color
}

export const applyFacilityTheme = (settings, root = document.documentElement) => {
  if (!root) return false

  const source = settings || {}
  const requestedPrimary = String(source.theme_primary_color || source.themePrimaryColor || '').trim()
  const requestedSecondary = String(source.theme_secondary_color || source.themeSecondaryColor || '').trim()
  const requestedAccent = String(source.theme_accent_color || source.themeAccentColor || '').trim()
  const primaryColor = isValidThemeColor(requestedPrimary) ? requestedPrimary : DEFAULT_FACILITY_THEME.primary
  const secondaryColor = isValidThemeColor(requestedSecondary) ? requestedSecondary : DEFAULT_FACILITY_THEME.secondary
  const accentColor = isValidThemeColor(requestedAccent) ? requestedAccent : DEFAULT_FACILITY_THEME.accent

  root.style.setProperty('--primary', primaryColor)
  root.style.setProperty('--primary-dark', mixHexColor(primaryColor, '#000000', 0.14))
  root.style.setProperty('--primary-light', mixHexColor(primaryColor, '#ffffff', 0.16))
  root.style.setProperty('--secondary', secondaryColor)
  root.style.setProperty('--secondary-light', mixHexColor(secondaryColor, '#ffffff', 0.12))
  root.style.setProperty('--accent', accentColor)
  root.style.setProperty('--on-primary', getReadableForeground(primaryColor))
  root.style.setProperty('--on-secondary', getReadableForeground(secondaryColor))
  root.style.setProperty('--on-accent', getReadableForeground(accentColor))
  root.style.setProperty('--on-sidebar', getReadableGradientForeground(primaryColor, secondaryColor))

  return true
}

export const announceFacilityThemeUpdate = (settings) => {
  applyFacilityTheme(settings)
  window.dispatchEvent(new CustomEvent(FACILITY_THEME_UPDATED_EVENT, { detail: settings }))
}
