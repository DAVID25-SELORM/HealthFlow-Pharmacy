// Ghana Card prefix rules for the local branch server. Kept in step with
// src/utils/nhiaMemberNumber.js in the web app (a test compares the two lists).
//
// A Ghana Card issued to a foreign national carries the holder's three-letter
// country code in place of GHA (for example KEN-#########-#). Only real
// ISO 3166-1 alpha-3 codes are accepted, so a typo such as GAH is still rejected.
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

export const compactGhanaCardValue = (value) =>
  String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '')

// GHA, or a foreign national's country code, or '' for an ordinary NHIS number.
export const getGhanaCardPrefix = (value) => {
  const prefix = compactGhanaCardValue(value).slice(0, 3)
  return GHANA_CARD_COUNTRY_PREFIXES.has(prefix) ? prefix : ''
}

export const isGhanaCardNumber = (value) => Boolean(getGhanaCardPrefix(value))
