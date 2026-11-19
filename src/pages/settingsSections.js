// Settings page sections. The page keeps every card exactly as before; these
// groups only decide which cards show together and what the side menu lists.

export const SETTINGS_GROUPS = [
  {
    id: 'facility',
    label: 'Facility',
    description: 'Branding, document headers and organization details.',
  },
  {
    id: 'branches',
    label: 'Branches & devices',
    description: 'Branch locations, the local branch server and secure workstation connections.',
  },
  {
    id: 'staff',
    label: 'Staff & access',
    description: 'Onboard staff and manage their accounts and offline access.',
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'NHIA claims connection and online payments.',
  },
  {
    id: 'data',
    label: 'Data & backup',
    description: 'Back up and restore pharmacy data.',
  },
  {
    id: 'account',
    label: 'My account',
    description: 'Your offline PIN, notifications, security and appearance.',
  },
]

export const DEFAULT_SETTINGS_GROUP = 'facility'

// Page anchors used by links elsewhere in the app (for example /settings#offline-access).
const ANCHOR_GROUPS = {
  'offline-access': 'account',
}

export function getAvailableSettingsGroups({ isAdmin = false } = {}) {
  return SETTINGS_GROUPS.filter((group) => (
    group.id === 'facility' || group.id === 'account' || isAdmin
  ))
}

export function settingsGroupFromHash(hash) {
  const id = String(hash || '').replace(/^#/, '').trim()
  if (!id) return ''
  if (ANCHOR_GROUPS[id]) return ANCHOR_GROUPS[id]
  return SETTINGS_GROUPS.some((group) => group.id === id) ? id : ''
}

export function resolveSettingsGroup(requested, availableGroups) {
  return availableGroups.some((group) => group.id === requested)
    ? requested
    : DEFAULT_SETTINGS_GROUP
}
