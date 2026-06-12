import crypto from 'node:crypto'
import fs from 'node:fs'

const [manifestPath, privateKeyPath] = process.argv.slice(2)
if (!manifestPath || !privateKeyPath) {
  throw new Error('Usage: node sign-update-manifest.mjs <manifest-path> <private-key-path>')
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')
const payload = [
  String(manifest.version || '').trim().replace(/^v/i, ''),
  String(manifest.channel || 'stable').trim().toLowerCase(),
  String(manifest.packageUrl || '').trim(),
  String(manifest.sha256 || '').trim().toLowerCase(),
  String(manifest.publishedAt || '').trim(),
].join('\n')

manifest.signature = crypto
  .sign(null, Buffer.from(payload, 'utf8'), privateKey)
  .toString('base64')

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
