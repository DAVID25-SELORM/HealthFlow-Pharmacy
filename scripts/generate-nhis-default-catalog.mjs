import fs from 'node:fs'

const source = fs.readFileSync('scripts/nhis-import-generated.sql', 'utf8')
const rowPattern = /\('((?:''|[^'])*)', '((?:''|[^'])*)', '((?:''|[^'])*)', ([0-9.]+), '((?:''|[^'])*)'\)/g

const unescapeSqlText = (value) => value.replace(/''/g, "'")
const escapeNonAscii = (text) =>
  text.replace(/[^\x00-\x7F]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

const rows = [...source.matchAll(rowPattern)].map((match) => ({
  code: unescapeSqlText(match[1]),
  description: unescapeSqlText(match[2]),
  unit: unescapeSqlText(match[3]),
  unit_price: Number(match[4]),
  category: unescapeSqlText(match[5]),
}))

if (rows.length < 500) {
  throw new Error(`Parsed only ${rows.length} NHIS drugs.`)
}

const output = `export const DEFAULT_NHIS_DRUG_CATALOG = ${JSON.stringify(rows, null, 2)}\n`
fs.writeFileSync('src/data/nhisDefaultDrugCatalog.js', escapeNonAscii(output))

console.log(`Generated ${rows.length} NHIS drugs.`)
