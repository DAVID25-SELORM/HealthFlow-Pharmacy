// Development-only: derive controlled TEST variants of an existing CXF so a Claim-IT import
// can show which structural difference (if any) it rejects. Reads a local file, writes to
// output/claimit-variants/<variant>/ (git-ignored; the files contain real claim data).
// It never invents clinical, patient, provider or signer data. It does not touch the exporter.
//
// Usage: node scripts/make-cxf-variants.mjs <source.cxf> [--signer-name N --signer-user U --signer-role R --signed-on "YYYY-MM-DD HH:MM:SS"]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { inflateSync, deflateSync } from 'node:zlib'

class Dbl { constructor(value) { this.value = value } }   // PHP float (kept distinct from int)
class PhpArr { constructor() { this.entries = [] } get(k) { return this.entries.find(([key]) => key === k)?.[1] }
  set(k, v) { const e = this.entries.find(([key]) => key === k); if (e) e[1] = v; else this.entries.push([k, v]) } }

function parse(buf) {
  let o = 0
  const until = (ch) => { const e = buf.indexOf(ch, o); const s = buf.subarray(o, e).toString(); o = e + 1; return s }
  const read = () => {
    const t = String.fromCharCode(buf[o++])
    if (t === 'N') { o++; return null }
    o++ // ':'
    if (t === 'b') return until(';') === '1'
    if (t === 'i') return Number(until(';'))
    if (t === 'd') return new Dbl(until(';'))
    if (t === 's') { const n = Number(until(':')); o++; const v = Buffer.from(buf.subarray(o, o + n)); o += n + 2; return v }
    if (t === 'a') { const n = Number(until(':')); o++; const a = new PhpArr(); for (let i = 0; i < n; i++) { const k = read(); a.entries.push([Buffer.isBuffer(k) ? k.toString() : k, read()]) } o++; return a }
    throw new Error(`Unsupported PHP type ${t}`)
  }
  const v = read(); if (o !== buf.length) throw new Error('trailing bytes'); return v
}
function write(v) {
  if (v === null) return Buffer.from('N;')
  if (typeof v === 'boolean') return Buffer.from(`b:${v ? 1 : 0};`)
  if (typeof v === 'number') return Buffer.from(`i:${v};`)
  if (v instanceof Dbl) return Buffer.from(`d:${v.value};`)
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`s:${v.length}:"`), v, Buffer.from('";')])
  if (v instanceof PhpArr) return Buffer.concat([Buffer.from(`a:${v.entries.length}:{`), ...v.entries.flatMap(([k, x]) => [write(typeof k === 'number' ? k : Buffer.from(k)), write(x)]), Buffer.from('}')])
  throw new Error('cannot serialize')
}
const S = (s) => Buffer.from(String(s))

const [source, ...rest] = process.argv.slice(2)
if (!source) throw new Error('Usage: node scripts/make-cxf-variants.mjs <source.cxf> [--signer-name ...]')
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : null }
const file = readFileSync(source)
if (!file.subarray(0, 3).equals(Buffer.from([1, 2, 25]))) throw new Error('not a CXF')
const payload = inflateSync(file.subarray(3))
const pack = (tree) => Buffer.concat([Buffer.from([1, 2, 25]), deflateSync(write(tree))])

// Fidelity gate: the writer must reproduce the original serialized payload byte for byte.
if (!write(parse(payload)).equals(payload)) throw new Error('round trip is not byte-identical; refusing to build variants')
console.log('round trip: byte-identical payload (' + payload.length + ' bytes)')

const data = (t) => t.get('data')
const claimsOf = (t) => data(t).get('claims').entries.map(([, c]) => c)
const moveAfter = (arr, key, after) => {          // reorder one key to sit right after another
  const idx = arr.entries.findIndex(([k]) => k === key); const [e] = arr.entries.splice(idx, 1)
  arr.entries.splice(arr.entries.findIndex(([k]) => k === after) + 1, 0, e)
}
const variants = {
  A_claimType_position_and_cpuType: (t) => {
    for (const c of claimsOf(t)) moveAfter(c, 'claimType', 'status')
    moveAfter(data(t).get('_dbstruct').get('claims'), 'claimType', 'status')
    data(t).get('_meta').get('appVersion').set('cpuType', S('x64'))
  },
  B_servVersion_null: (t) => {
    for (const c of claimsOf(t)) c.set('servVersion', null)
    const sv = data(t).get('_meta').get('servVersions'); for (const [k] of sv.entries) sv.set(k, null)
  },
  D_empty_validation_sections: (t) => {
    for (const s of ['validations', 'validation_zclaims', 'prescribersfordays']) data(t).get(s).entries.length = 0
  },
}
const signer = { name: opt('signer-name'), user: opt('signer-user'), role: opt('signer-role'), on: opt('signed-on') }
if (signer.name && signer.user && signer.role && signer.on) {
  variants.C_signers_populated = (t) => { for (const c of claimsOf(t)) {
    c.set('signedOn', S(signer.on)); c.set('signedByname', S(signer.name)); c.set('signedByuserID', S(signer.user)); c.set('signedByrole', S(signer.role)) } }
} else console.log('variant C skipped: pass --signer-name --signer-user --signer-role --signed-on (real exporting user; nothing is invented)')
variants.ABD_all_but_signers = (t) => { for (const k of Object.keys(variants)) if (/^[ABD]_/.test(k)) variants[k](t) }
if (variants.C_signers_populated) variants.ABCD_all_four = (t) => { for (const k of Object.keys(variants)) if (/^[ABCD]_/.test(k)) variants[k](t) }

const out = join('output', 'claimit-variants')
for (const [name, apply] of Object.entries(variants)) {
  const tree = parse(payload); apply(tree)
  const dir = join(out, name); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, basename(source)), pack(tree))
  console.log('wrote', join(dir, '<same filename>'))
}
