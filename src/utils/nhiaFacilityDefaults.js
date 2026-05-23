const normalizeText = (value) => String(value ?? '').trim()
const normalizeIdentity = (value) => normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, '')

const getFirstText = (...values) => values.map(normalizeText).find(Boolean) || ''

// ✅ NHIA CONFIG PATCH START
const normalizeCode = (value) => normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '')

export const normalizeNhiaFacilityType = (value, fallback = '') => {
  const normalized = normalizeText(value).toLowerCase()
  if (normalized.includes('hospital')) return 'Hospital'
  if (normalized.includes('clinic')) return 'Clinic'
  if (normalized.includes('maternity')) return 'Maternity'
  if (normalized.includes('chemical')) return 'Chemical Seller'
  if (normalized.includes('pharmacy')) return 'Pharmacy'
  return fallback
}

const NHIA_HOSPITAL_FACILITY_TYPES = ['Hospital', 'Clinic', 'Maternity']
const NHIA_PHARMACY_FACILITY_TYPES = ['Pharmacy', 'Chemical Seller']

const normalizeOrganizationType = (value) =>
  normalizeText(value).toLowerCase() === 'hospital' ? 'hospital' : 'pharmacy'

export const getNhiaFacilityTypesForOrganization = (organizationType = 'pharmacy') =>
  normalizeOrganizationType(organizationType) === 'hospital'
    ? NHIA_HOSPITAL_FACILITY_TYPES
    : NHIA_PHARMACY_FACILITY_TYPES

export const normalizeNhiaFacilityTypeForOrganization = (value, organizationType = 'pharmacy') => {
  const normalizedOrganizationType = normalizeOrganizationType(organizationType)
  const fallback = normalizedOrganizationType === 'hospital' ? 'Hospital' : 'Pharmacy'
  const facilityType = normalizeNhiaFacilityType(value, fallback)
  const allowedTypes = getNhiaFacilityTypesForOrganization(normalizedOrganizationType)

  return allowedTypes.includes(facilityType) ? facilityType : fallback
}

export const normalizeNhiaPharmacyFacilityLevel = (value, fallback = '') => {
  const code = normalizeCode(value)
  return ['P1', 'P2', 'LCS', 'HP'].includes(code) ? code : fallback
}

export const normalizeNhiaProviderClassLevel = (value, fallback = '') => {
  const code = normalizeCode(value)
  return ['B1', 'B2', 'C', 'D', 'M', 'SM'].includes(code) ? code : fallback
}
// ✅ NHIA CONFIG PATCH END

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
      credentialCode: '03-05-001-02-01954-11-P1-2-011225',
      providerNumber: '03-05-01954',
      providerTypeDescription: 'Pharmacy',
      facilityType: 'Pharmacy',
      pharmacyFacilityLevel: 'P1',
      providerClassLevel: 'C',
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
  // ✅ NHIA CONFIG PATCH START
  const organizationType = normalizeOrganizationType(org.organization_type)
  const facilityType = normalizeNhiaFacilityTypeForOrganization(
    getFirstText(
      source.facilityType,
      source.facility_type,
      source.providerTypeDescription,
      source.provider_type_description,
      org.facility_type,
      org.organization_type,
      knownDefaults.facilityType
    ),
    organizationType
  )
  const isPharmacy = organizationType === 'pharmacy'
  const credentialCode = getFirstText(
    source.credentialCode,
    source.credential_code,
    source.facilityCode,
    source.facility_code,
    org.claimit_facility_code,
    org.nhia_facility_code,
    org.nhia_credential_code,
    org.credential_code,
    org.facility_code,
    knownDefaults.credentialCode,
    knownDefaults.facilityCode
  )
  const rawProviderClassLevel = getFirstText(
    source.providerClassLevel,
    source.provider_class_level,
    org.provider_class_level,
    org.providerClassLevel,
    org.nhia_provider_class_level,
    knownDefaults.providerClassLevel
  )
  const rawPharmacyFacilityLevel = getFirstText(
    source.pharmacyFacilityLevel,
    source.pharmacy_facility_level,
    source.pharmacyLevel,
    source.pharmacy_level,
    org.pharmacy_facility_level,
    org.pharmacy_level,
    knownDefaults.pharmacyFacilityLevel
  )
  const providerClassLevel = normalizeNhiaProviderClassLevel(rawProviderClassLevel, isPharmacy ? 'C' : '')
  const pharmacyFacilityLevel = isPharmacy
    ? normalizeNhiaPharmacyFacilityLevel(rawPharmacyFacilityLevel, 'P1')
    : ''
  // ✅ NHIA CONFIG PATCH END

  return {
    ...source,
    // ✅ NHIA CONFIG PATCH START
    facilityType,
    pharmacyFacilityLevel,
    providerClassLevel,
    providerLevelCode: getFirstText(source.providerLevelCode, source.provider_level_code),
    credentialCode,
    licenseNumber: getFirstText(source.licenseNumber, source.license_number, org.license_number),
    accreditationExpiryDate: getFirstText(
      source.accreditationExpiryDate,
      source.accreditation_expiry_date,
      org.accreditation_expiry_date
    ),
    _inferredProviderClassLevel: !normalizeNhiaProviderClassLevel(rawProviderClassLevel) && Boolean(providerClassLevel),
    _inferredPharmacyFacilityLevel: !normalizeNhiaPharmacyFacilityLevel(rawPharmacyFacilityLevel) && Boolean(pharmacyFacilityLevel),
    // ✅ NHIA CONFIG PATCH END
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
      knownDefaults.providerTypeDescription,
      facilityType
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
