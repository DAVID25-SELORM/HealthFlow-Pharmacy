const normalizeText = (value) => String(value ?? '').trim()
const normalizeIdentity = (value) => normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, '')

const getFirstText = (...values) => values.map(normalizeText).find(Boolean) || ''

// ✅ NHIA CONFIG PATCH START
const normalizeCode = (value) => normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '')

export const normalizeNhiaAccreditationExpiryDate = (value) => {
  const raw = normalizeText(value)
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const isoDate = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]/)?.[1]
  if (isoDate) return isoDate

  const localDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (localDate) {
    const [, day, month, year] = localDate
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)

  return ''
}

export const getNhiaAccreditationExpiryDate = (...sources) =>
  normalizeNhiaAccreditationExpiryDate(
    sources.map((source) => {
      if (!source || typeof source !== 'object') return source
      return getFirstText(
        source.accreditationExpiryDate,
        source.accreditationExpiry,
        source.nhiaAccreditationExpiry,
        source.accreditation_expiry_date,
        source.expiryDate
      )
    }).find(Boolean)
  )

export const normalizeNhiaFacilityType = (value, fallback = '') => {
  const normalized = normalizeText(value).toLowerCase()
  // Check hospital pharmacy before plain hospital to avoid misclassification.
  if (normalized.includes('hospital') && normalized.includes('pharmacy')) return 'Hospital Pharmacy'
  if (normalized.includes('hospital')) return 'Hospital'
  if (normalized.includes('clinic')) return 'Clinic'
  if (normalized.includes('maternity')) return 'Maternity'
  if (normalized.includes('chemical')) return 'Chemical Seller'
  if (normalized.includes('pharmacy')) return 'Pharmacy'
  return fallback
}

const NHIA_HOSPITAL_FACILITY_TYPES = ['Hospital', 'Clinic', 'Maternity', 'Hospital Pharmacy']
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
  // HP is only valid for hospital pharmacies (organization_type = 'hospital', facilityType = 'Hospital Pharmacy').
  // Community pharmacies use P1, P2, or LCS only.
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

const STANDARD_GHANA_NHIS_DEFAULTS = {
  schemeName: 'National Health Insurance',
  apiBaseUrl: 'https://elig.nhia.gov.gh:5000',
  productionBaseUrl: 'http://localhost:31719/json-api',
  claimitSubmitBaseUrl: 'http://localhost:31719/json-api',
  claimEndpointPath: '/claims',
  claimSubmitEndpoint: '/claims',
  memberLookupEndpointPath: '/api/hmis/genCCC',
  memberLookupEndpoint: '/api/hmis/genCCC',
  integrationMode: 'claimit_assisted',
  connectionProfile: 'local_server',
  validationMode: 'validate_before_submit',
  claimControlMode: 'manual',
  admissionPaymentOption: 'nhis_pays_admission',
  claimitValidationEnabled: true,
  directApiEnabled: false,
  credentialMode: 'claimit_token',
  tokenEndpointPath: '/token',
  exportFormat: 'json',
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
    schemeName: getFirstText(source.schemeName, source.scheme_name, STANDARD_GHANA_NHIS_DEFAULTS.schemeName),
    scheme_name: getFirstText(source.scheme_name, source.schemeName, STANDARD_GHANA_NHIS_DEFAULTS.schemeName),
    apiBaseUrl: getFirstText(source.apiBaseUrl, source.api_base_url, STANDARD_GHANA_NHIS_DEFAULTS.apiBaseUrl),
    api_base_url: getFirstText(source.api_base_url, source.apiBaseUrl, STANDARD_GHANA_NHIS_DEFAULTS.apiBaseUrl),
    productionBaseUrl: getFirstText(source.productionBaseUrl, source.production_base_url, STANDARD_GHANA_NHIS_DEFAULTS.productionBaseUrl),
    production_base_url: getFirstText(source.production_base_url, source.productionBaseUrl, STANDARD_GHANA_NHIS_DEFAULTS.productionBaseUrl),
    claimitSubmitBaseUrl: getFirstText(source.claimitSubmitBaseUrl, source.claimit_submit_base_url, source.productionBaseUrl, source.production_base_url, STANDARD_GHANA_NHIS_DEFAULTS.claimitSubmitBaseUrl),
    claimit_submit_base_url: getFirstText(source.claimit_submit_base_url, source.claimitSubmitBaseUrl, source.production_base_url, source.productionBaseUrl, STANDARD_GHANA_NHIS_DEFAULTS.claimitSubmitBaseUrl),
    claimEndpointPath: getFirstText(source.claimEndpointPath, source.claim_endpoint_path, source.claimSubmitEndpoint, source.claim_submit_endpoint, STANDARD_GHANA_NHIS_DEFAULTS.claimEndpointPath),
    claim_endpoint_path: getFirstText(source.claim_endpoint_path, source.claimEndpointPath, source.claim_submit_endpoint, source.claimSubmitEndpoint, STANDARD_GHANA_NHIS_DEFAULTS.claimEndpointPath),
    claimSubmitEndpoint: getFirstText(source.claimSubmitEndpoint, source.claim_submit_endpoint, source.claimEndpointPath, source.claim_endpoint_path, STANDARD_GHANA_NHIS_DEFAULTS.claimSubmitEndpoint),
    claim_submit_endpoint: getFirstText(source.claim_submit_endpoint, source.claimSubmitEndpoint, source.claim_endpoint_path, source.claimEndpointPath, STANDARD_GHANA_NHIS_DEFAULTS.claimSubmitEndpoint),
    memberLookupEndpointPath: getFirstText(source.memberLookupEndpointPath, source.member_lookup_endpoint_path, source.memberLookupEndpoint, source.member_lookup_endpoint, STANDARD_GHANA_NHIS_DEFAULTS.memberLookupEndpointPath),
    member_lookup_endpoint_path: getFirstText(source.member_lookup_endpoint_path, source.memberLookupEndpointPath, source.member_lookup_endpoint, source.memberLookupEndpoint, STANDARD_GHANA_NHIS_DEFAULTS.memberLookupEndpointPath),
    memberLookupEndpoint: getFirstText(source.memberLookupEndpoint, source.member_lookup_endpoint, source.memberLookupEndpointPath, source.member_lookup_endpoint_path, STANDARD_GHANA_NHIS_DEFAULTS.memberLookupEndpoint),
    member_lookup_endpoint: getFirstText(source.member_lookup_endpoint, source.memberLookupEndpoint, source.member_lookup_endpoint_path, source.memberLookupEndpointPath, STANDARD_GHANA_NHIS_DEFAULTS.memberLookupEndpoint),
    integrationMode: getFirstText(source.integrationMode, source.integration_mode, STANDARD_GHANA_NHIS_DEFAULTS.integrationMode),
    integration_mode: getFirstText(source.integration_mode, source.integrationMode, STANDARD_GHANA_NHIS_DEFAULTS.integrationMode),
    connectionProfile: getFirstText(source.connectionProfile, source.connection_profile, STANDARD_GHANA_NHIS_DEFAULTS.connectionProfile),
    connection_profile: getFirstText(source.connection_profile, source.connectionProfile, STANDARD_GHANA_NHIS_DEFAULTS.connectionProfile),
    validationMode: getFirstText(source.validationMode, source.validation_mode, STANDARD_GHANA_NHIS_DEFAULTS.validationMode),
    validation_mode: getFirstText(source.validation_mode, source.validationMode, STANDARD_GHANA_NHIS_DEFAULTS.validationMode),
    claimControlMode: getFirstText(source.claimControlMode, source.claim_control_mode, STANDARD_GHANA_NHIS_DEFAULTS.claimControlMode),
    claim_control_mode: getFirstText(source.claim_control_mode, source.claimControlMode, STANDARD_GHANA_NHIS_DEFAULTS.claimControlMode),
    admissionPaymentOption: getFirstText(source.admissionPaymentOption, source.admission_payment_option, STANDARD_GHANA_NHIS_DEFAULTS.admissionPaymentOption),
    admission_payment_option: getFirstText(source.admission_payment_option, source.admissionPaymentOption, STANDARD_GHANA_NHIS_DEFAULTS.admissionPaymentOption),
    claimitValidationEnabled: source.claimitValidationEnabled ?? source.claimit_validation_enabled ?? STANDARD_GHANA_NHIS_DEFAULTS.claimitValidationEnabled,
    claimit_validation_enabled: source.claimit_validation_enabled ?? source.claimitValidationEnabled ?? STANDARD_GHANA_NHIS_DEFAULTS.claimitValidationEnabled,
    directApiEnabled: source.directApiEnabled ?? source.direct_api_enabled ?? STANDARD_GHANA_NHIS_DEFAULTS.directApiEnabled,
    direct_api_enabled: source.direct_api_enabled ?? source.directApiEnabled ?? STANDARD_GHANA_NHIS_DEFAULTS.directApiEnabled,
    credentialMode: getFirstText(source.credentialMode, source.credential_mode, STANDARD_GHANA_NHIS_DEFAULTS.credentialMode),
    credential_mode: getFirstText(source.credential_mode, source.credentialMode, STANDARD_GHANA_NHIS_DEFAULTS.credentialMode),
    exportFormat: getFirstText(source.exportFormat, source.export_format, STANDARD_GHANA_NHIS_DEFAULTS.exportFormat),
    export_format: getFirstText(source.export_format, source.exportFormat, STANDARD_GHANA_NHIS_DEFAULTS.exportFormat),
    credentials: {
      ...(source.credentials || {}),
      headerName: getFirstText(source.credentials?.headerName, source.apiKeyHeaderName, source.api_key_header_name, 'x-nhia-apikey'),
      secretHeaderName: getFirstText(source.credentials?.secretHeaderName, source.apiSecretHeaderName, source.api_secret_header_name, 'x-nhia-apisecret'),
      tokenEndpointPath: getFirstText(source.credentials?.tokenEndpointPath, source.tokenEndpointPath, source.token_endpoint_path, STANDARD_GHANA_NHIS_DEFAULTS.tokenEndpointPath),
    },
    // ✅ NHIA CONFIG PATCH START
    facilityType,
    pharmacyFacilityLevel,
    providerClassLevel,
    providerLevelCode: getFirstText(source.providerLevelCode, source.provider_level_code),
    credentialCode,
    licenseNumber: getFirstText(source.licenseNumber, source.license_number, org.license_number),
    accreditationExpiryDate: getNhiaAccreditationExpiryDate(source, org),
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
