export const formatActiveOrganizationsNotice = (organizations = [], windowMinutes = 15) => {
  if (!organizations.length) {
    return `No organizations have recorded activity in the last ${windowMinutes} minutes.`
  }

  const visibleNames = organizations
    .slice(0, 6)
    .map((organization) => String(organization?.name || '').trim())
    .filter(Boolean)
  const remaining = Math.max(0, organizations.length - visibleNames.length)
  const suffix = remaining > 0 ? ` and ${remaining} more` : ''
  const label = organizations.length === 1 ? 'organization is' : 'organizations are'

  return `${organizations.length} ${label} actively operating: ${visibleNames.join(', ')}${suffix}.`
}
