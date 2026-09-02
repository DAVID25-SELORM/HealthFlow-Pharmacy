export const FACILITY_THEME_UPDATED_EVENT = 'healthflow:facility-theme-updated'

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

export const isValidThemeColor = (value) => HEX_COLOR_PATTERN.test(String(value || '').trim())

const mixHexColor = (hexColor, targetColor, weight) => {
  const source = hexColor.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16))
  const target = targetColor.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16))

  return `#${source
    .map((channel, index) => Math.round(channel + (target[index] - channel) * weight))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`
}

export const applyFacilityTheme = (settings, root = document.documentElement) => {
  if (!settings || !root) return false

  const primaryColor = String(settings.theme_primary_color || settings.themePrimaryColor || '').trim()
  const secondaryColor = String(settings.theme_secondary_color || settings.themeSecondaryColor || '').trim()
  const accentColor = String(settings.theme_accent_color || settings.themeAccentColor || '').trim()
  let applied = false

  if (isValidThemeColor(primaryColor)) {
    root.style.setProperty('--primary', primaryColor)
    root.style.setProperty('--primary-dark', mixHexColor(primaryColor, '#000000', 0.14))
    root.style.setProperty('--primary-light', mixHexColor(primaryColor, '#ffffff', 0.16))
    applied = true
  }

  if (isValidThemeColor(secondaryColor)) {
    root.style.setProperty('--secondary', secondaryColor)
    root.style.setProperty('--secondary-light', mixHexColor(secondaryColor, '#ffffff', 0.12))
    applied = true
  }

  if (isValidThemeColor(accentColor)) {
    root.style.setProperty('--accent', accentColor)
    applied = true
  }

  return applied
}

export const announceFacilityThemeUpdate = (settings) => {
  applyFacilityTheme(settings)
  window.dispatchEvent(new CustomEvent(FACILITY_THEME_UPDATED_EVENT, { detail: settings }))
}
