const normalizeText = (value) => String(value ?? '').trim()
const normalizeIdentity = (value) => normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, '')

const getFirstText = (...values) => values.map(normalizeText).find(Boolean) || ''

const KNOWN_NHIA_FACILITIES = [
  {
    aliases: [
      'westpoint',
      'westpointchemist',
      '030501954',
      '030501954westpointchemist',
      '030501954westpoint',
    ],
    defaults: {
      facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
    },
  },
]

const getKnownFacilityDefaults = (organization = {}) => {
  const identity = [
    organization?.name,
    organization?.pharmacy_name,
    organization?.display_name,
    organization?.subdomain,
    organization?.facility_code,
    organization?.claimit_facility_code,
    organization?.nhia_facility_code,
    organization?.provider_number,
    organization?.nhia_provider_number,
  ].map(normalizeIdentity).filter(Boolean)

  const matched = KNOWN_NHIA_FACILITIES.find((facility) =>
    facility.aliases.some((alias) =>
      identity.some((value) => value === alias || value.includes(alias))
    )
  )

  return matched?.defaults || {}
}

export const applyNhiaFacilityDefaults = (settings = null, organization = null) => {
  const knownDefaults = getKnownFacilityDefaults(organization || {})
  const source = settings || {}
  const org = organization || {}

  return {
    ...source,
    facilityCode: getFirstText(
      source.facilityCode,
      source.facility_code,
      org.claimit_facility_code,
      org.nhia_facility_code,
      org.nhia_credential_code,
      org.credential_code,
      org.facility_code,
      knownDefaults.facilityCode
    ),
    providerNumber: getFirstText(
      source.providerNumber,
      source.provider_number,
      org.nhia_provider_number,
      org.nhia_provider_code,
      org.provider_number,
      org.provider_code,
      knownDefaults.providerNumber
    ),
    schemeName: getFirstText(source.schemeName, source.scheme_name, 'National Health Insurance'),
    providerTypeDescription: getFirstText(
      source.providerTypeDescription,
      source.provider_type_description,
      org.provider_type_description,
      org.providerTypeDescription,
      knownDefaults.providerTypeDescription
    ),
    providerClassLevel: getFirstText(
      source.providerClassLevel,
      source.provider_class_level,
      org.provider_class_level,
      org.providerClassLevel,
      org.nhia_provider_class_level
    ),
  }
}

export const hasNhiaFacilitySettings = (settings = null) =>
  Boolean(
    getFirstText(
      settings?.facilityCode,
      settings?.facility_code,
      settings?.providerNumber,
      settings?.provider_number,
      settings?.providerTypeDescription,
      settings?.provider_type_description,
      settings?.providerClassLevel,
      settings?.provider_class_level,
      settings?.apiBaseUrl,
      settings?.api_base_url,
      settings?.claimEndpointPath,
      settings?.claim_endpoint_path,
      settings?.ccCodeEndpointPath,
      settings?.cc_code_endpoint_path
    )
  )
