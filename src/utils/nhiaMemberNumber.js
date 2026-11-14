export const DEFAULT_NHIS_MEMBER_DIGITS = 8
export const DEFAULT_GHANA_CARD_DIGITS = 10
export const GHANA_CARD_COUNTRY_PREFIX = 'GHA'

// A Ghana Card issued to a foreign national carries the holder's three-letter
// country code in place of GHA (for example KEN-#########-# or SWZ-#########-#).
// Only real ISO 3166-1 alpha-3 codes are accepted, so a typo such as GAH is still
// rejected instead of being treated as a card number.
export const GHANA_CARD_COUNTRY_PREFIXES = new Set(
  (
    'ABW AFG AGO AIA ALA ALB AND ARE ARG ARM ASM ATA ATF ATG AUS AUT AZE BDI BEL BEN BES BFA BGD BGR BHR BHS BIH ' +
    'BLM BLR BLZ BMU BOL BRA BRB BRN BTN BVT BWA CAF CAN CCK CHE CHL CHN CIV CMR COD COG COK COL COM CPV CRI CUB ' +
    'CUW CXR CYM CYP CZE DEU DJI DMA DNK DOM DZA ECU EGY ERI ESH ESP EST ETH FIN FJI FLK FRA FRO FSM GAB GBR GEO ' +
    'GGY GHA GIB GIN GLP GMB GNB GNQ GRC GRD GRL GTM GUF GUM GUY HKG HMD HND HRV HTI HUN IDN IMN IND IOT IRL IRN ' +
    'IRQ ISL ISR ITA JAM JEY JOR JPN KAZ KEN KGZ KHM KIR KNA KOR KWT LAO LBN LBR LBY LCA LIE LKA LSO LTU LUX LVA ' +
    'MAC MAF MAR MCO MDA MDG MDV MEX MHL MKD MLI MLT MMR MNE MNG MNP MOZ MRT MSR MTQ MUS MWI MYS MYT NAM NCL NER ' +
    'NFK NGA NIC NIU NLD NOR NPL NRU NZL OMN PAK PAN PCN PER PHL PLW PNG POL PRI PRK PRT PRY PSE PYF QAT REU ROU ' +
    'RUS RWA SAU SDN SEN SGP SGS SHN SJM SLB SLE SLV SMR SOM SPM SRB SSD STP SUR SVK SVN SWE SWZ SXM SYC SYR TCA ' +
    'TCD TGO THA TJK TKL TKM TLS TON TTO TUN TUR TUV TWN TZA UGA UKR UMI URY USA UZB VAT VCT VEN VGB VIR VNM VUT ' +
    'WLF WSM YEM ZAF ZMB ZWE'
  ).split(' ')
)

export const digitsOnly = (value) => String(value || '').replace(/\D/g, '')

const asText = (value) => String(value ?? '').trim()
const compactGhanaCardValue = (value) => asText(value).toUpperCase().replace(/[\s-]/g, '')

// The three-letter prefix of a Ghana Card number (GHA, or a foreign national's
// country code), or '' when the value is an ordinary NHIS member number.
export const getGhanaCardPrefix = (value) => {
  const prefix = compactGhanaCardValue(value).slice(0, 3)
  return GHANA_CARD_COUNTRY_PREFIXES.has(prefix) ? prefix : ''
}

export const isGhanaCardNumber = (value) => Boolean(getGhanaCardPrefix(value))

export const normalizeNhiaMemberNumber = (value) => {
  const text = asText(value)
  if (!text) return ''

  const prefix = getGhanaCardPrefix(text)
  if (!prefix) {
    return /^\d+$/.test(text) ? text : text.toUpperCase()
  }

  const compact = compactGhanaCardValue(text)
  const digits = digitsOnly(compact.slice(3))
  // Format while typing as well as after the full Ghana Card number is
  // entered: GHA-#########-# (or KEN-#########-# for a foreign national). This
  // keeps the visible input unambiguous and avoids requiring users to add
  // either hyphen themselves.
  return `${prefix}-${digits.slice(0, 9)}${digits.length > 9 ? `-${digits.slice(9, DEFAULT_GHANA_CARD_DIGITS)}` : ''}`
}

export const validateNhiaMemberNumberFormat = (
  value,
  {
    nhisMemberDigits = DEFAULT_NHIS_MEMBER_DIGITS,
    ghanaCardDigits = DEFAULT_GHANA_CARD_DIGITS,
  } = {}
) => {
  const memberNumber = asText(value)
  if (!memberNumber) {
    return 'Enter the patient NHIS member number or Ghana Card number.'
  }

  const prefix = getGhanaCardPrefix(memberNumber)
  if (prefix) {
    const compact = compactGhanaCardValue(memberNumber)
    const digits = digitsOnly(compact.slice(3))
    const requiredDigits = Number(ghanaCardDigits) || DEFAULT_GHANA_CARD_DIGITS

    if (!/^[A-Z]{3}\d+$/.test(compact)) {
      return `Ghana Card number must start with ${prefix} and contain only digits after the prefix.`
    }

    if (digits.length !== requiredDigits) {
      return `Ghana Card number must contain exactly ${requiredDigits} digits after ${prefix}.`
    }

    return ''
  }

  const requiredDigits = Number(nhisMemberDigits) || DEFAULT_NHIS_MEMBER_DIGITS
  if (!/^\d+$/.test(memberNumber)) {
    return 'NHIS member number must contain digits only, or enter a Ghana Card number starting with GHA (or the three-letter country code, for foreign nationals).'
  }

  if (memberNumber.length !== requiredDigits) {
    return `NHIS member number must contain exactly ${requiredDigits} digits.`
  }

  return ''
}
