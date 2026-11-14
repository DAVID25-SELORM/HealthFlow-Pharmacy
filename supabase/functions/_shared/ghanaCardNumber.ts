// Ghana Card number rules shared by the edge functions. Kept in step with
// src/utils/nhiaMemberNumber.js (web app) and local-branch-server/src/nhiaMemberNumber.js;
// a test compares the three prefix lists.
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
  ).split(' '),
)

const GHANA_CARD_FORMAT = /^([A-Z]{3})-\d{9}-\d$/

// Canonical form only: upper case, hyphenated CCC-#########-#.
export const isCanonicalGhanaCardNumber = (value: unknown): boolean => {
  const match = GHANA_CARD_FORMAT.exec(typeof value === 'string' ? value : '')
  return Boolean(match && GHANA_CARD_COUNTRY_PREFIXES.has(match[1]))
}

// Same check, tolerating surrounding spaces and lower case.
export const isGhanaCardNumber = (value: unknown): boolean =>
  isCanonicalGhanaCardNumber(String(value ?? '').trim().toUpperCase())
